"""时间线多卡展示（对齐 opencode-feishu timeline-card.ts 模式）。

飞书卡片编辑会带"已编辑"时间显示，单卡反复重写体验差；时间线模式下一次轮次
按事件顺序生成多张独立小卡：
- 用户卡：提问确认（"收到，开始处理…"，无按钮）
- 💭 思考过程卡：reasoning 快照实时刷新（partId 边界，一张）
- 工具卡：每个 callId 一张，标题=工具名，正文=命令/入参 + 输出，终态定格
- 📝 处理中卡：过程性叙述文本（partId 边界）
- 🤖 最终答复卡：idle/终态时才创建（保证时间线顺序），带终态 status

每张运行中的卡带中断按钮（用户卡/最终卡除外）。单卡更新失败仅跳过该卡，
不阻断轮次。
"""
import asyncio
import json
import logging
import re
import time

import lark_oapi as lark
from lark_oapi.api.cardkit.v1 import (
    ContentCardElementRequest,
    ContentCardElementRequestBody,
    CreateCardElementRequest,
    CreateCardElementRequestBody,
    CreateCardRequest,
    CreateCardRequestBody,
    DeleteCardElementRequest,
    DeleteCardElementRequestBody,
)

from . import commands

log = logging.getLogger("nexus-feishu")

THROTTLE_S = 2.5
STATUS_ELEM = "reply_status"
TEXT_ELEM = "reply_text"
ACTIONS_ELEM = "reply_actions"

EMPTY_PLACEHOLDER = "_⏳ 等待中…_"

TERMINAL_TEMPLATES = {
    "completed": "green",
    "failed": "red",
    "canceled": "grey",
}

# element_id 只允许字母/数字/下划线且 ≤20 字符（300301 实测）
_MD_ELEM_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,19}$")


def _md_element(element_id: str, content: str) -> dict:
    assert _MD_ELEM_RE.match(element_id), f"bad element_id: {element_id}"
    return {"tag": "markdown", "element_id": element_id, "content": content}


def _actions_element(buttons: list[dict]) -> dict | None:
    """按钮列：schema 2.0 不支持 tag:action，按 column_set/column 包裹。"""
    if not buttons:
        return None
    return {
        "tag": "column_set",
        "element_id": ACTIONS_ELEM,
        "flex_mode": "none",
        "background_style": "default",
        "columns": [
            {"tag": "column", "width": "weighted", "weight": 1, "elements": [b]}
            for b in buttons
        ],
    }


def normalize_title(text: str, fallback: str = "处理中") -> str:
    """标题 = 首行非空文本，去 markdown 符号，截 72（对齐 normalizeReplyTitle）。"""
    normalized = (text or "").replace("\r", "\n")
    first = next((ln.strip() for ln in normalized.split("\n") if ln.strip()), "")
    first = re.sub(r"\s+", " ", first)
    first = re.sub(r"[`*_#\[\]]", "", first).strip()
    return (first[:71].rstrip() + "…") if len(first) > 72 else (first or fallback)


def _tool_content(input_: dict | None, output: str | None) -> str:
    """工具卡正文：命令/入参 + 输出（对齐 buildToolContent）。"""
    sections = []
    cmd = ""
    if isinstance(input_, dict):
        cmd = str(input_.get("command") or input_.get("cmd")
                  or input_.get("command_line") or input_.get("description") or "")
    if cmd.strip():
        sections.append(f"**命令**\n```\n{cmd.strip()[:1500]}\n```")
    elif isinstance(input_, dict) and input_:
        sections.append(f"**入参**\n```\n{json.dumps(input_, ensure_ascii=False)[:1200]}\n```")
    if output and output.strip():
        sections.append(f"**输出**\n```\n{output.strip()[:1500]}\n```")
    return "\n\n".join(sections) if sections else EMPTY_PLACEHOLDER


def _abort_button(round_key: str) -> dict:
    return {
        "tag": "button",
        "text": {"tag": "plain_text", "content": "🛑 中断"},
        "type": "danger",
        "value": {"action": "abort", "taskId": round_key},
    }


class TimelineCard:
    """单张时间线卡：状态区 + 内容区 + 按钮区。节流渲染 + 内容快照去重。"""

    def __init__(self, gw, chat_id: str) -> None:
        self.gw = gw
        self.chat_id = chat_id
        self.card_id = ""
        self.message_id = ""
        self.seq = 0
        self.closed = False
        self.degraded = False
        self._fail_streak = 0
        self.has_actions = False
        self._buttons: list[dict] = []
        self._status = ""
        self._text = ""
        self._rendered_status = ""
        self._rendered_text = ""
        self._dirty = False
        self._rendering = False

    async def start(self, title: str, status: str = "", content: str = "",
                    buttons: list[dict] | None = None) -> bool:
        """创建 cardkit 卡片并发送。失败返回 False（调用方跳过该卡）。"""
        self._status = status
        self._text = content
        self._buttons = buttons or []
        self.has_actions = bool(self._buttons)
        try:
            loop = asyncio.get_running_loop()
            schema = self._schema(title)
            # cardkit v1 create 要求 type="card_json" + data=JSON 字符串
            body = CreateCardRequestBody.builder() \
                .type("card_json") \
                .data(json.dumps(schema, ensure_ascii=False)) \
                .build()
            req = CreateCardRequest.builder().request_body(body).build()
            resp = await loop.run_in_executor(None, self.gw.lark.cardkit.v1.card.create, req)
            if not resp.success() or not resp.data or not resp.data.card_id:
                log.error("cardkit create 失败: %s", resp.msg)
                return False
            self.card_id = resp.data.card_id
            self._rendered_status = status
            self._rendered_text = self._norm_text(content)
        except Exception as e:  # noqa: BLE001
            log.error("cardkit create 异常: %s", e)
            return False
        try:
            from lark_oapi.api.im.v1 import CreateMessageRequest, CreateMessageRequestBody

            req = CreateMessageRequest.builder() \
                .receive_id_type("chat_id") \
                .request_body(CreateMessageRequestBody.builder()
                              .receive_id(self.chat_id)
                              .msg_type("interactive")
                              .content(json.dumps({"type": "card", "data": {"card_id": self.card_id}}))
                              .build()) \
                .build()
            resp = await loop.run_in_executor(None, self.gw.lark.im.v1.message.create, req)
            if not resp.success():
                log.error("发送卡片消息失败: %s", resp.msg)
                return False
            self.message_id = resp.data.message_id or ""
            return True
        except Exception as e:  # noqa: BLE001
            log.error("发送卡片消息异常: %s", e)
            return False

    def _schema(self, title: str) -> dict:
        elements = []
        if self._status:
            elements.append(_md_element(STATUS_ELEM, self._status))
        elements.append(_md_element(TEXT_ELEM, self._norm_text(self._text)))
        actions = _actions_element(self._buttons)
        if actions is not None:
            elements.append(actions)
        return {
            "schema": "2.0",
            "config": {"streaming_mode": True, "wide_screen_mode": True},
            "header": {
                "title": {"tag": "plain_text", "content": title[:72]},
                "template": "blue",
            },
            "body": {"elements": elements},
        }

    @staticmethod
    def _norm_text(text: str) -> str:
        cleaned = (text or "").replace("\r", "\n")
        cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
        return cleaned[:2800] if cleaned else EMPTY_PLACEHOLDER

    # ────────────── 更新（调度 → 节流渲染） ──────────────

    def set_status(self, status: str) -> None:
        if self.closed or status == self._status:
            return
        self._status = status
        self._dirty = True
        self._kick()

    def replace_text(self, full_text: str) -> None:
        if self.closed or full_text == self._text:
            return
        self._text = full_text
        self._dirty = True
        self._kick()

    def set_buttons(self, buttons: list[dict]) -> None:
        """按钮增删走 cardElement create/delete（增量更新不支持 actions 区）。"""
        if self.closed or buttons == self._buttons:
            return
        self._buttons = buttons
        self._dirty = True
        self._sync_actions = True
        self._kick()

    def close(self) -> None:
        """定格：终态图标由调用方先写好文本；这里只停刷新 + 移除按钮。"""
        if self.closed:
            return
        self.closed = True
        if self._buttons:
            self._buttons = []
            self._dirty = True
            self._sync_actions = True

    # ────────────── 渲染 ──────────────

    def _kick(self) -> None:
        if self._rendering or self.closed:
            return
        self._rendering = True
        asyncio.get_running_loop().create_task(self._render_when_idle())

    async def _render_when_idle(self) -> None:
        try:
            await asyncio.sleep(0.3)  # debounce 合并窗口
            if not self._dirty:
                return
            self._dirty = False
            await self._push()
        finally:
            self._rendering = False
            if self._dirty and not self.closed:
                self._kick()

    async def _push(self) -> None:
        if not self.card_id or self.degraded:
            return
        loop = asyncio.get_running_loop()
        ok = True

        async def _content(elem_id: str, md_text: str, snap: str) -> None:
            nonlocal ok
            rendered = self._rendered_status if snap == "status" else self._rendered_text
            if rendered == md_text:
                return
            try:
                body = ContentCardElementRequestBody.builder() \
                    .content(md_text) \
                    .sequence(self.seq + 1) \
                    .build()
                req = ContentCardElementRequest.builder() \
                    .card_id(self.card_id) \
                    .element_id(elem_id) \
                    .request_body(body) \
                    .build()
                resp = await loop.run_in_executor(
                    None, self.gw.lark.cardkit.v1.card_element.content, req)
                if resp.success():
                    if snap == "status":
                        self._rendered_status = md_text
                    else:
                        self._rendered_text = md_text
                else:
                    log.error("cardkit content 更新失败 %s: %s", elem_id, resp.msg)
                    ok = False
                self.seq += 1
            except Exception as e:  # noqa: BLE001
                log.warning("cardkit content 更新异常 %s: %s", elem_id, e)
                ok = False

        if self._status:
            await _content(STATUS_ELEM, self._status, "status")
        await _content(TEXT_ELEM, self._norm_text(self._text), "text")

        # 按钮区增删（status/reply 快照语义之外的一次性动作）
        want_actions = bool(self._buttons)
        if want_actions != self.has_actions or getattr(self, "_sync_actions", False):
            actions_el = _actions_element(self._buttons)
            try:
                if want_actions and not self.has_actions:
                    body = CreateCardElementRequestBody.builder() \
                        .type("append") \
                        .elements(json.dumps([actions_el], ensure_ascii=False)) \
                        .sequence(self.seq + 1) \
                        .build()
                    req = CreateCardElementRequest.builder() \
                        .card_id(self.card_id).request_body(body).build()
                    resp = await loop.run_in_executor(
                        None, self.gw.lark.cardkit.v1.card_element.create, req)
                    if resp.success():
                        self.has_actions = True
                    else:
                        ok = False
                    self.seq += 1
                elif not want_actions and self.has_actions:
                    body = DeleteCardElementRequestBody.builder() \
                        .sequence(self.seq + 1).build()
                    req = DeleteCardElementRequest.builder() \
                        .card_id(self.card_id) \
                        .element_id(ACTIONS_ELEM) \
                        .request_body(body).build()
                    resp = await loop.run_in_executor(
                        None, self.gw.lark.cardkit.v1.card_element.delete, req)
                    if resp.success():
                        self.has_actions = False
                    else:
                        ok = False
                    self.seq += 1
                self._sync_actions = False
            except Exception as e:  # noqa: BLE001
                log.warning("cardkit actions 增删异常: %s", e)
                ok = False

        if not ok:
            self._fail_streak += 1
            if self._fail_streak >= 3:
                log.error("timeline card 连续失败，degraded: %s", self.card_id)
                self.degraded = True
        else:
            self._fail_streak = 0


class RoundCards:
    """一次轮次的卡组编排（对齐 TimelineManager）。

    user / thinking / transition:{partId} / tool:{callId} / final 卡；
    pending 队列 200ms flush 按到达序建卡；final 卡 finalize 时才建。
    """

    FLUSH_DELAY = 0.2

    def __init__(self, gw, chat_id: str, round_key: str) -> None:
        self.gw = gw
        self.chat_id = chat_id
        self.round_key = round_key
        self.user_card: TimelineCard | None = None
        self.thinking_card: TimelineCard | None = None
        self.thinking_part = ""
        self.tool_cards: dict[str, TimelineCard] = {}
        self.trans_cards: dict[str, TimelineCard] = {}
        self.final_card: TimelineCard | None = None
        self.finalized = False
        self.pending_final_text = ""  # 最终回答流式暂存（finalize 时一次性出卡）
        self._pending: dict[str, dict] = {}  # key → {title, content, buttons, kind}
        self._pending_seq = 0  # 插入序号（flush 按到达序建卡，保证时间线顺序）
        self._flush_task: asyncio.Task | None = None
        self._queue: asyncio.Queue = asyncio.Queue()
        self._worker = asyncio.create_task(self._run_queue())
        self._terminal_status = ""

    # ────────────── 对外 API（内部串行队列） ──────────────

    def ensure_user_card(self, question: str) -> None:
        title = normalize_title(question, "新对话")
        existing = self._pending.get("user")
        if existing is not None:
            # user 事件先建了空文本占位卡，user-text 到达时更新标题与内容
            existing["title"] = title
            existing["content"] = f"**{title}**\n\n_收到，开始处理…_"
            return
        if self.user_card is not None:
            return
        self._enqueue_create("user", {
            "title": title,
            "status": "",
            "content": f"**{title}**\n\n_收到，开始处理…_",
            "buttons": [],
        })

    def ensure_thinking(self, part_id: str, text: str) -> None:
        if self.finalized or not text.strip():
            return
        if self.thinking_card is not None and self.thinking_part == part_id:
            self.thinking_card.replace_text(text)
            return
        self._enqueue_create(f"think:{part_id}", {
            "title": "💭 思考过程",
            "status": "",
            "content": text,
            "buttons": [_abort_button(self.round_key)],
        })

    def ensure_tool(self, call_id: str, tool: str, state_: str,
                    input_: dict | None = None, output: str | None = None) -> None:
        if self.finalized:
            return
        existing = self.tool_cards.get(call_id)
        if existing is not None:
            if input_:
                existing.replace_text(_tool_content(input_, output))
            if state_ in ("completed", "error"):
                icon = "✅" if state_ == "completed" else "❌"
                existing.set_status(f"{icon} 已完成" if state_ == "completed" else "❌ 出错")
                self._close_card(existing)
                self.tool_cards.pop(call_id, None)
            return
        self._enqueue_create(f"tool:{call_id}", {
            "title": normalize_title(tool, "工具调用")[:50] or "工具调用",
            "status": "🔄 运行中",
            "content": _tool_content(input_, output),
            "buttons": [_abort_button(self.round_key)],
        })

    def ensure_text(self, part_id: str, text: str) -> None:
        """过程性叙述卡。"""
        if self.finalized:
            return
        effective = text.strip()
        if not effective:
            return
        existing = self.trans_cards.get(part_id)
        if existing is not None:
            existing.replace_text(effective)
            return
        self._enqueue_create(f"trans:{part_id}", {
            "title": "📝 处理中",
            "status": "",
            "content": effective,
            "buttons": [],
        })

    def finalize(self, state_: str, conclusion: str = "") -> None:
        """终态：定格所有活动卡 + 创建最终答复卡（保证时间线顺序）。"""
        if self.finalized:
            return
        self.finalized = True
        self._enqueue_create("final", {
            "title": "🤖 最终答复",
            "status": "✅ 已完成" if state_ == "completed"
            else ("❌ 已失败" if state_ == "failed" else "⛔ 已中断"),
            "content": conclusion or EMPTY_PLACEHOLDER,
            "buttons": [],
            "close_after": True,
        })
        # 已建活动卡排队 close（删按钮、停刷新）
        for card in [self.user_card, self.thinking_card, *self.tool_cards.values(),
                     *self.trans_cards.values()]:
            if card is not None:
                self._enqueue_close(card)
        self.user_card = None
        self.thinking_card = None
        self.tool_cards.clear()
        self.trans_cards.clear()

    def set_round_buttons(self, buttons: list[dict]) -> None:
        """权限/提问按钮：挂到最新活动卡（thinking/tool 优先，否则 pending final 前的卡）。"""
        card = self.thinking_card or (next(iter(self.tool_cards.values()), None)
                                      if self.tool_cards else None)
        if card is not None:
            card.set_buttons(buttons)

    def abort_result(self, ok: bool) -> None:
        """中断按钮回调：成功则 finalize(canceled)。"""
        if ok:
            self.finalize("canceled", "⛔ 已中断")
        # 失败不动（状态文本由 gateway 写）

    # ────────────── pending flush ──────────────

    def _enqueue_create(self, key: str, item: dict) -> None:
        if key in self._pending:
            self._pending[key].update(item)
            return
        item["_seq"] = self._pending_seq
        self._pending_seq += 1
        self._pending[key] = item
        if self._flush_task is None or self._flush_task.done():
            self._flush_task = asyncio.get_running_loop().create_task(self._flush_later())

    async def _flush_later(self) -> None:
        await asyncio.sleep(self.FLUSH_DELAY)
        await self._flush()

    async def _flush(self) -> None:
        if self.finalized and not any(k == "final" for k in self._pending):
            return
        items = sorted(self._pending.items(), key=lambda kv: kv[1].get("_seq", 0))
        self._pending.clear()
        for key, item in items:
            card = TimelineCard(self.gw, self.chat_id)
            ok = await card.start(item["title"], item.get("status", ""),
                                  item.get("content", ""), item.get("buttons"))
            if not ok:
                continue
            if item.get("close_after"):
                card.close()
                await card._push()
                self.final_card = card
            elif key == "user":
                self.user_card = card
            elif key.startswith("think:"):
                self.thinking_part = key.split(":", 1)[1]
                self.thinking_card = card
            elif key.startswith("tool:"):
                self.tool_cards[key.split(":", 1)[1]] = card
            elif key.startswith("trans:"):
                self.trans_cards[key.split(":", 1)[1]] = card

    def _close_card(self, card: TimelineCard) -> None:
        self._queue.put_nowait(("close", card))

    def _enqueue_close(self, card: TimelineCard) -> None:
        self._queue.put_nowait(("close", card))

    async def _run_queue(self) -> None:
        while True:
            kind, card = await self._queue.get()
            try:
                if kind == "close":
                    card.close()
                    await card._push()
            except Exception as e:  # noqa: BLE001
                log.warning("round card 队列操作异常: %s", e)
            finally:
                self._queue.task_done()

    async def aclose(self) -> None:
        if self._worker is not None:
            self._worker.cancel()


class CardManager:
    """round_key/task_id → RoundCards。"""

    def __init__(self, gw) -> None:  # noqa: ANN001
        self.gw = gw
        self.rounds: dict[str, RoundCards] = {}

    def get(self, key: str) -> RoundCards | None:
        return self.rounds.get(key)

    def register(self, key: str, round_: RoundCards) -> None:
        self.rounds[key] = round_

    def drop(self, key: str) -> None:
        rc = self.rounds.pop(key, None)
        if rc is not None:
            asyncio.get_running_loop().create_task(rc.aclose())
