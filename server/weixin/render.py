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
    return f"📨 已派发任务 `{(task_id or '')[:8]}`，执行中。过程会实时同步到这里；发送 /swarm status 可查进度。"


def assistant_final(text: str, failed: bool = False, error: str = "") -> str:
    """微信自己派的任务：最终回答全量（completed 时一次性发，替代简报）。"""
    body = md(text)
    if failed:
        return f"❌ 任务失败\n{md(error) or body or '执行出错'}"
    if not body:
        return "✅ 任务完成（无文本回答）"
    return f"💬 {body}"


def thinking_text(text: str) -> str:
    return f"{THINK_PREFIX} {md(text)[:800]}"


def tool_start_text(tool: str, input_data: dict | None = None) -> str:
    return f"{TOOL_PREFIX} {tool} {tool_args_summary(tool, input_data)}…"


def tool_done_text(tool: str, ok: bool, input_data: dict | None = None) -> str:
    return f"{TOOL_PREFIX} {tool} {tool_args_summary(tool, input_data)}{'✓' if ok else '✗'}"


def tool_args_summary(tool: str, input_data: dict | None) -> str:
    """工具关键参数摘要（微信文本行）：bash 命令 / 读写文件路径 / 通用首参数。

    参照 web 前端 toolCommand 的取法（command/cmd/command_line/description），
    再补文件类工具的 file_path/file/pattern 等常见键。过长截断，无参数返回空。
    """
    if not isinstance(input_data, dict) or not input_data:
        return ""
    cmd = input_data.get("command") or input_data.get("cmd") or input_data.get("command_line")
    if isinstance(cmd, str) and cmd.strip():
        return f"`{cmd.strip()[:120]}` "
    for key in ("file_path", "path", "file", "filename", "pattern", "query", "url", "description"):
        v = input_data.get(key)
        if isinstance(v, str) and v.strip():
            return f"`{v.strip()[:120]}` "
    # 编辑类：多个 path
    edits = input_data.get("edits") or input_data.get("files")
    if isinstance(edits, list) and edits:
        names = []
        for e in edits[:3]:
            if isinstance(e, dict):
                p = e.get("path") or e.get("file_path") or ""
                if p:
                    names.append(str(p))
        if names:
            return "`" + ", ".join(names)[:120] + "` "
    try:
        s = str(next(v for v in input_data.values() if v))
        return f"`{s[:120]}` " if s else ""
    except StopIteration:
        return ""


def permission_text(task_id: str, kind: str, question: str, options: list[str]) -> str:
    """权限/提问文本卡：编号选项，回复数字或文字。

    permission 固定三个选项（与 reply 端点语义对齐：1=允许一次 once / 2=始终允许 always / 3=拒绝 reject）；
    opencode 的 permission.asked 不带 options，必须在这里补。
    """
    label = "需要授权" if kind == "permission" else "向你提问"
    lines = [f"⏸ 任务 `{task_id[:8]}` {label}"]
    if question:
        lines.append(question[:500])
    if kind == "permission":
        lines.append("1. 允许一次")
        lines.append("2. 始终允许")
        lines.append("3. 拒绝")
        lines.append("回复编号即可")
    elif options:
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


def a2a_stream_text(event: dict) -> tuple[str | None, str]:
    """微信自己派的任务：A2A 事件 → 详细流文本。

    metadata.nexus 标签为 snake_case（参照插件 nexus_a2a.ts：call_id/tool_state/part_id/mode）。
    返回 (text | None, kind)；kind ∈ reasoning / tool_start / tool_done / final / failed / ""（跳过）。
    """
    kind = event.get("kind")
    if kind == "artifact-update":
        return None, ""  # 最终回答由 completed 一次性发（artifact 与流式 text 重复）
    meta = event.get("metadata") or {}
    state = str((event.get("status") or {}).get("state", ""))
    if state == "input-required":
        data = _input_data(event)
        opts = [str(o if isinstance(o, str) else (o.get("label") or o.get("value") or ""))
                for o in (data.get("options") or [])[:6]]
        opts = [o for o in opts if o]
        q = str(data.get("question") or "AI 需要确认")
        return permission_text(str(event.get("taskId", "")), str(data.get("type", "permission")), q, opts), "input"
    if state == "failed":
        err = _parts_text(event) or "执行出错"
        return f"❌ 任务 `{str(event.get('taskId',''))[:8]}` 失败：{md(err)[:400]}", "failed"
    if state in ("completed", "canceled"):
        # 最终回答全量（artifact 优先，退流式累积）——由调用方补 artifact，这里给状态头
        return None, "final"
    ntype = str(meta.get("nexus", ""))
    if ntype == "reasoning":
        t = str(meta.get("text", "") or "")
        return (thinking_text(t), "reasoning") if t else (None, "")
    if ntype == "tool":
        name = str(meta.get("tool") or "工具调用")
        st = str(meta.get("tool_state") or "running")
        input_data = meta.get("input") if isinstance(meta.get("input"), dict) else None
        if st in ("running", "input-required", ""):
            return tool_start_text(name, input_data), "tool_start"
        return tool_done_text(name, st == "completed", input_data), "tool_done"
    if ntype == "text":
        return None, ""  # 流式 text 不逐段发，completed 时全量发（避免碎片刷屏）
    return None, ""


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
