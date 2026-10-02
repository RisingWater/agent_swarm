"""规划器人工待办 → 飞书提醒卡（协议 §7；两个操作按钮）。

由 `planner_channel` 的待办分发钩子（`register_pending_listener`）驱动：
- action=pending：向属主 `brief_on` 的飞书窗口推一张带两个按钮的操作卡；
- action=resolved：向已发卡的窗口推「已处理」收尾卡（收起按钮）。

按钮 `value={action:"planner_op", workspace_id, op, payload}`，gateway 回调
（`gateway._on_card_action` 的 `planner_op` 分支）调 `planner_channel.dispatch_op`
真正下发；core 离线（409）时回调侧 toast 提示，按钮保留可重试。

本模块**不做**任何 op 下发/状态判断，只负责渲染与窗口筛选（与 `perm_card.py` 同构）。
"""
import logging

from sqlmodel import Session

from server import models, planner_channel
from server.db import engine

from . import state

log = logging.getLogger("nexus-feishu")

# key → set[chat_id]（已发过卡的窗口，收尾用）
_active: dict[str, set[str]] = {}

# 按钮顺序即展示顺序：kind → [(label, op, type)]
_ACTIONS: dict[str, list[tuple[str, str, str]]] = {
    "plan_approval": [("✅ 通过拆解", "plan.approve", "primary"),
                      ("🔁 重新拆解", "plan.revise", "default")],
    "task_acceptance": [("✅ 通过", "task.accept", "primary"),
                        ("❌ 拒绝", "task.reject", "danger")],
}

# op → 中文标签（回调替换卡/微信回执共用语义）
OP_LABELS = {
    "plan.approve": "通过拆解",
    "plan.revise": "重新拆解",
    "task.accept": "通过",
    "task.reject": "拒绝",
}


def _buttons(item: dict) -> list[dict]:
    """按 kind 生成两个按钮（拿不到 kind 时按验收处理，保证总有可点项）。"""
    kind = str(item.get("kind") or "")
    ws_id = str(item.get("workspace_id") or "")
    out: list[dict] = []
    for label, op, btn_type in _ACTIONS.get(kind, _ACTIONS["task_acceptance"]):
        if op.startswith("plan."):
            payload = {"goal_id": str(item.get("goal_id") or "")}
        else:
            payload = {"task_id": str(item.get("task_id") or "")}
        out.append({
            "tag": "button",
            "text": {"tag": "plain_text", "content": label},
            "type": btn_type,
            "value": {"action": "planner_op", "workspace_id": ws_id, "op": op, "payload": payload},
        })
    return out


def planner_card(item: dict) -> dict:
    """待办操作卡：标题 + 摘要 + 两个按钮。"""
    kind = str(item.get("kind") or "")
    title = str(item.get("title") or "").strip() or (
        "拆解待审批" if kind == "plan_approval" else "人工验收待处理")
    detail = str(item.get("detail") or "").strip()
    body = [f"📋 {title}"]
    if detail:
        body.append(detail)
    btns = _buttons(item)
    elements: list[dict] = [
        {"tag": "div", "text": {"tag": "lark_md", "content": "\n\n".join(body)}},
        {"tag": "hr"},
        {
            "tag": "column_set", "flex_mode": "none", "background_style": "default",
            "columns": [{"tag": "column", "width": "weighted", "weight": 1, "elements": [b]}
                        for b in btns],
        },
        {"tag": "note", "elements": [{"tag": "plain_text",
                                      "content": "点击按钮审批/验收，或到网页「规划器」页操作"}]},
    ]
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "template": "orange" if kind == "plan_approval" else "blue",
            "title": {"tag": "plain_text", "content": title[:40]},
        },
        "elements": elements,
    }


def submitted_card(op: str) -> dict:
    """回调成功后替换原卡（按钮收起）。"""
    label = OP_LABELS.get(op, op)
    return {
        "config": {"wide_screen_mode": True},
        "header": {"template": "green", "title": {"tag": "plain_text", "content": "✅ 已提交"}},
        "elements": [{
            "tag": "div",
            "text": {"tag": "lark_md",
                     "content": f"已提交：**{label}**，规划器处理中。结果会同步到「规划器」页。"},
        }],
    }


def resolved_card(item: dict) -> dict:
    """收尾卡：待办已处理或状态已变（协议 §7.2 清键）。"""
    title = str(item.get("title") or "规划器待办")
    reason = str(item.get("resolved_reason") or "")
    text = f"✅ 规划器待办已处理：{title}"
    if reason and reason != "op_result":
        text += f"\n（状态已变化：{reason}）"
    return {
        "config": {"wide_screen_mode": True},
        "header": {"template": "grey", "title": {"tag": "plain_text", "content": "🔔 规划器待办收尾"}},
        "elements": [{"tag": "div", "text": {"tag": "lark_md", "content": text}}],
    }


# ---------------------------------------------------------------- 分发钩子

async def _on_pending(workspace_id: str, action: str, item: dict) -> None:
    key = str(item.get("key") or "")
    if not key:
        return
    if action == "pending":
        await _push_planner_card(workspace_id, item)
    elif action == "resolved":
        await _push_resolved(workspace_id, item)


async def _push_planner_card(workspace_id: str, item: dict) -> None:
    with Session(engine) as s:
        ws = s.get(models.Workspace, workspace_id)
        if ws is None or not ws.user_id:
            return
        owner_user_id = ws.user_id
    # 只发属主名下 brief_on 的窗口（与权限卡/简报同款窗口筛选，限属主防跨用户）
    chats = state.brief_chats_all(owner_user_id, set())
    if not chats:
        return
    gw = _gw_ref()
    if gw is None:
        return
    card = planner_card(item)
    _active[str(item.get("key"))] = {c.chat_id for c in chats}
    for chat in chats:
        try:
            await gw.send_card(chat.chat_id, card)
        except Exception:  # noqa: BLE001
            log.exception("planner 卡推送失败 chat=%s", chat.chat_id)
    log.info("planner 卡已推送 key=%s windows=%s", str(item.get("key"))[:40], len(chats))


async def _push_resolved(workspace_id: str, item: dict) -> None:
    chat_ids = _active.pop(str(item.get("key") or ""), None)
    if not chat_ids:
        return
    gw = _gw_ref()
    if gw is None:
        return
    card = resolved_card(item)
    for chat_id in chat_ids:
        try:
            await gw.send_card(chat_id, card)
        except Exception:  # noqa: BLE001
            log.exception("planner 收尾卡推送失败 chat=%s", chat_id)


def bind_listener() -> None:
    planner_channel.register_pending_listener(_on_pending)


def unbind_listener() -> None:
    planner_channel.unregister_pending_listener(_on_pending)


_gw_instance = None


def set_gateway(gw) -> None:
    global _gw_instance
    _gw_instance = gw


def _gw_ref():
    if _gw_instance is None:
        # bridge.manager().gw 兜底（bind_gateway 时已注入）
        from . import bridge

        _gw = getattr(bridge.manager(), "gw", None)
        if _gw is not None:
            set_gateway(_gw)
    return _gw_instance
