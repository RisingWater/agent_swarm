"""A2A 事件/任务 → 微信文本渲染。

微信无卡片/按钮（对照飞书），表达方式：
- 简报：Markdown 文本（FINISH 全量发送，微信 2.1.3+ 官方支持 Markdown 输入，渲染程度待真机实测）
- thinking：监控模式下发纯文本（折叠前缀）
- tool：优先官方 tool_call item（type 11/12，2.4.4+，普通客户端显示效果待实测）；失败降级文本行
- 权限/提问：文本编号选项，用户回复数字/文字由 commands.py 路由到 reply
"""
from __future__ import annotations

import json
import re

THINK_PREFIX = "💭"
TOOL_PREFIX = "🔧"


def md(text: str) -> str:
    """裁剪 + 规整 Markdown（微信端渲染程度未知，保守用基础语法）。"""
    return (text or "").strip()[:2500]


def brief_text(task_instr: str, answer: str, error: str, failed: bool, ws_name: str) -> str:
    """任务完成简报（MD）：提问首行 + 回答/失败原因。"""
    head = f"{'❌ 任务失败' if failed else '✅ 任务完成'} · {ws_name}"
    q_lines = [ln.strip() for ln in (task_instr or "").splitlines() if ln.strip()]
    parts = [f"**{head}**"]
    if q_lines:
        parts.append(f"**❓ 提问**\n{q_lines[0][:200]}")
    if failed:
        parts.append(f"**💥 失败原因**\n{md(error) or '执行出错'}")
    else:
        if md(answer):
            parts.append(f"**💬 回答**\n{md(answer)}")
        else:
            parts.append("_（无最终回答文本）_")
    return "\n\n".join(parts)


def task_accepted_text(task_id: str) -> str:
    return f"📨 已派发任务 `{(task_id or '')[:8]}`，执行中。完成后这里会收到简报；发送 /swarm status 可查进度。"


def thinking_text(text: str) -> str:
    return f"{THINK_PREFIX} {md(text)[:800]}"


def tool_start_text(tool: str) -> str:
    return f"{TOOL_PREFIX} {tool} …"


def tool_done_text(tool: str, ok: bool) -> str:
    return f"{TOOL_PREFIX} {tool} {'✓' if ok else '✗'}"


def permission_text(task_id: str, kind: str, question: str, options: list[str]) -> str:
    """权限/提问文本卡：编号选项，回复数字或文字。"""
    label = "需要授权" if kind == "permission" else "向你提问"
    lines = [f"⏸ 任务 `{task_id[:8]}` {label}"]
    if question:
        lines.append(question[:500])
    if options:
        for i, opt in enumerate(options, 1):
            lines.append(f"{i}. {opt}")
        lines.append("回复编号或输入你的答案")
    else:
        lines.append("直接回复你的答案")
    return "\n".join(lines)


# ---------------------------------------------------------------- 事件流解析（监控/任务事件 → 文本）


def _parts_text(event: dict) -> str:
    art = event.get("artifact") or {}
    parts = art.get("parts") if "artifact" in event else ((event.get("status") or {}).get("message") or {}).get("parts")
    out = []
    for p in parts or []:
        if p.get("kind") == "text" and p.get("text"):
            out.append(str(p["text"]))
    return "\n".join(out)


def _input_data(event: dict) -> dict:
    msg = (event.get("status") or {}).get("message") or {}
    for p in msg.get("parts") or []:
        if p.get("kind") == "data":
            return p.get("data") or {}
    return {}


def event_to_texts(event: dict) -> list[str]:
    """A2A 事件（status-update/artifact-update/监控 payload）→ 一条或多条待发送文本。

    返回空列表 = 该事件对微信无意义（跳过）。
    """
    # 监控 payload（{"type": user|thinking|tool|text|..., roundKey...}，无 kind）
    if not event.get("kind") and event.get("type"):
        return monitor_texts(event)
    kind = event.get("kind")
    state = str((event.get("status") or {}).get("state", ""))
    if kind == "artifact-update":
        return []  # 全量文本由简报负责（artifact 每轮重复发全量，不刷屏）
    if kind == "status-update":
        if state == "input-required":
            data = _input_data(event)
            opts = [str(o if isinstance(o, str) else (o.get("label") or o.get("value") or ""))
                    for o in (data.get("options") or [])[:6]]
            opts = [o for o in opts if o]
            q = str(data.get("question") or "AI 需要确认")
            return [permission_text(str(event.get("taskId", "")), str(data.get("type", "permission")), q, opts)]
        if state == "failed":
            err = _parts_text(event) or "执行出错"
            return [f"❌ 任务 `{str(event.get('taskId',''))[:8]}` 失败：{md(err)[:400]}"]
        return []
    return []


def monitor_texts(payload: dict) -> list[str]:
    """监控事件 → 文本（thinking 发文本；tool 由 bridge 决定官方 item 或文本）。"""
    mtype = str(payload.get("type", ""))
    if mtype == "thinking":
        t = str(payload.get("text", "") or "")
        return [thinking_text(t)] if t else []
    if mtype == "text":
        return []  # 监控轮的中间 text 不发（回答由简报兜底），避免刷屏
    return []


def tool_item_start(call_id: str, tool: str) -> dict:
    return {"type": 11, "tool_call_start_item": {"tool_name": tool, "tool_call_id": call_id or _client_hint()}}


def tool_item_result(call_id: str, tool: str, ok: bool) -> dict:
    return {"type": 12, "tool_call_result_item": {"tool_name": tool, "tool_call_id": call_id or _client_hint(),
                                                  "status": 0 if ok else 1}}


def _client_hint() -> str:
    import secrets

    return secrets.token_hex(8)


def extract_json_objects(raw: str) -> list[dict]:
    """辅助：容错解析（暂未用，保留给后续 tool payload 解析）。"""
    out = []
    for chunk in re.findall(r"\{.*?\}", raw or "", re.S):
        try:
            out.append(json.loads(chunk))
        except ValueError:
            continue
    return out
