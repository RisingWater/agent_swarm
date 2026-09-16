"""流式任务卡片：CardKit streaming card（一次任务一张卡，实时更新）。

- create（schema 2.0, streaming_mode）→ im 发送 card_id 引用 → element content 增量更新
- 节流 2.5s 合并刷新；thinking 折叠为"思考中…"；tool 逐条状态行；text 为回答正文
- 常驻 🛑 中断按钮（working 时）；终态收尾（header 换色 + 按钮移除 + 耗时）
- 权限/提问（input-required）：卡片插入按钮区（允许/拒绝/选项），点击走 reply 链路

卡片元素固定 id：status / reply / tools / actions（创建时顺序注册，content 更新按 id 定位）。
"""
import asyncio
import json
import logging
import time

import lark_oapi as lark
from lark_oapi.api.cardkit.v1 import (
    ContentCardElementRequest,
    ContentCardElementRequestBody,
    CreateCardRequest,
    CreateCardRequestBody,
)

from . import commands

log = logging.getLogger("nexus-feishu")

THROTTLE_S = 2.5
ELEM_STATUS = "elem_status"
ELEM_REPLY = "elem_reply"
ELEM_TOOLS = "elem_tools"
ELEM_ACTIONS = "elem_actions"

RUNNING_TEMPLATES = {
    "queued": "blue",
    "working": "blue",
    "input-required": "orange",
}
TERMINAL_TEMPLATES = {
    "completed": "green",
    "failed": "red",
    "canceled": "grey",
}


def _md_element(element_id: str, content: str) -> dict:
    return {"tag": "markdown", "element_id": element_id, "content": content}


def _abort_button_value(task_id: str) -> str:
    return {"action": "abort", "taskId": task_id}


def _reply_button_value(task_id: str, reply: str) -> dict:
    return {"action": "feishu_reply", "taskId": task_id, "reply": reply}


class StreamingCard:
    """一个任务/轮次对应一张卡。所有更新调用方无需 await（内部串行队列 + 节流）。"""

    def __init__(self, gw, chat_id: str, task_id: str, title: str) -> None:
        self.gw = gw
        self.chat_id = chat_id
        self.task_id = task_id
        self.title = title
        self.card_id = ""
        self.message_id = ""
        self.seq = 0
        self.closed = False
        self.degraded = False  # cardkit 不可用时降级为纯文本收尾
        # 视图状态
        self.status_text = "已受理"
        self.reply_text = ""
        self.tool_lines: list[str] = []
        self.actions: list[dict] = []
        self.header_template = RUNNING_TEMPLATES["queued"]
        self._dirty = asyncio.Event()
        self._loop_task: asyncio.Task | None = None
        self._last_render = 0.0
        self._thinking_seen = False

    # ────────────── 创建与发送 ──────────────

    async def open(self) -> bool:
        """创建 cardkit 卡片并发送到聊天。失败返回 False（调用方降级纯文本）。"""
        try:
            loop = asyncio.get_running_loop()
            # cardkit v1 create 要求 type="card_json" + data=JSON 字符串
            # （传裸 dict 报 99992402 field validation failed，实测 2026-09-16）
            body = CreateCardRequestBody.builder() \
                .type("card_json") \
                .data(json.dumps(self._schema(), ensure_ascii=False)) \
                .build()
            req = CreateCardRequest.builder().request_body(body).build()
            resp = await loop.run_in_executor(None, self.gw.lark.cardkit.v1.card.create, req)
            if not resp.success() or not resp.data or not resp.data.card_id:
                log.error("cardkit create 失败: %s", resp.msg)
                return False
            self.card_id = resp.data.card_id
        except Exception as e:  # noqa: BLE001
            log.error("cardkit create 异常: %s", e)
            return False
        # 发送卡片消息（card 引用）
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

    def start(self) -> None:
        self._loop_task = asyncio.create_task(self._render_loop())

    async def close(self) -> None:
        self.closed = True
        self._dirty.set()
        if self._loop_task is not None:
            try:
                await asyncio.wait_for(self._loop_task, timeout=8)
            except Exception:  # noqa: BLE001
                self._loop_task.cancel()

    # ────────────── 更新入口（事件驱动） ──────────────

    def update_status(self, status_text: str, template: str | None = None) -> None:
        self.status_text = status_text
        if template:
            self.header_template = template
        self._dirty.set()

    def flush_now(self) -> None:
        """跳过节流立即渲染一次（关键状态：input-required / 终态 / 已应答）。"""
        if self._loop_task is not None and not self._loop_task.done():
            # 清掉节流等待的下一次渲染时间，让 _render_loop 立即通过
            self._last_render = 0.0
        self._dirty.set()

    def update_reasoning(self) -> None:
        self._thinking_seen = True
        self.status_text = "思考中…"
        self._dirty.set()

    def append_tool(self, line: str) -> None:
        icon_line = f"⚙️ {line}"
        if icon_line not in self.tool_lines:
            self.tool_lines.append(icon_line)
            if len(self.tool_lines) > 12:
                self.tool_lines = self.tool_lines[-12:]
        self.status_text = "执行工具中…"
        self._dirty.set()

    def set_reply(self, full_text: str) -> None:
        if full_text:
            self.reply_text = full_text
        self._dirty.set()

    def set_actions(self, actions: list[dict]) -> None:
        self.actions = actions
        self._dirty.set()

    def finish(self, state_: str, detail: str = "") -> None:
        self.header_template = TERMINAL_TEMPLATES.get(state_, "grey")
        label = {"completed": "✅ 已完成", "failed": "❌ 失败", "canceled": "⛔ 已中断"}.get(state_, state_)
        self.status_text = f"{label}" + (f" · {detail}" if detail else "")
        self.actions = []
        self._dirty.set()

    # ────────────── 渲染 ──────────────

    def _schema(self) -> dict:
        elements = [
            _md_element(ELEM_STATUS, self._status_md()),
            _md_element(ELEM_REPLY, self._reply_md()),
            _md_element(ELEM_TOOLS, self._tools_md()),
            self._actions_element(),
        ]
        return {
            "schema": "2.0",
            "config": {"streaming_mode": True, "wide_screen_mode": True},
            "header": {
                "title": {"tag": "plain_text", "content": self.title[:100]},
                "template": self.header_template,
            },
            "body": {"elements": [e for e in elements if e is not None]},
        }

    def _status_md(self) -> str:
        return f"**{self.status_text}**"

    def _reply_md(self) -> str:
        if self.reply_text:
            return self.reply_text[:2800]
        if self._thinking_seen:
            return "_思考中…_"
        return "_等待 agent 输出…_"

    def _tools_md(self) -> str:
        if not self.tool_lines:
            return " "
        return "\n".join(self.tool_lines)

    def _actions_element(self) -> dict | None:
        """按钮列：schema 2.0 卡片**不支持 tag:action**，按 opencode-feishu 的
        column_set/column 包裹（cardkit create 实测 99992402 unsupported tag action）。"""
        if not self.actions:
            return None
        return {
            "tag": "column_set",
            "element_id": ELEM_ACTIONS,
            "flex_mode": "none",
            "background_style": "default",
            "columns": [
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [a]}
                for a in self.actions
            ],
        }

    async def _render_loop(self) -> None:
        """节流渲染：dirty 即计划刷新，距上次渲染 <THROTTLE_S 则等待合并。"""
        while True:
            await self._dirty.wait()
            self._dirty.clear()
            now = time.monotonic()
            wait = self._last_render + THROTTLE_S - now
            if wait > 0:
                try:
                    await asyncio.wait_for(self._dirty.wait(), timeout=wait)
                    self._dirty.clear()  # 期间又 dirty：直接重渲染（合并窗口内）
                except asyncio.TimeoutError:
                    pass
            if self.closed and not self._dirty.is_set():
                pass  # 收尾仍需渲染一次
            self._last_render = time.monotonic()
            await self._push_render()
            if self.closed:
                return

    async def _push_render(self) -> None:
        """cardkit element content 更新（header/actions 不支持增量，靠整体重建仅在 open 时有效；
        header 模板变化与 actions 增删用"降级 patch 消息"实现——先 element 更新，失败再 patch）。"""
        if not self.card_id or self.degraded:
            return
        loop = asyncio.get_running_loop()
        updates = [
            (ELEM_STATUS, self._status_md()),
            (ELEM_REPLY, self._reply_md()),
            (ELEM_TOOLS, self._tools_md()),
        ]
        ok = True
        for elem_id, content in updates:
            try:
                # sequence 必填（自增，幂等去重用），缺省报 99992402
                body = ContentCardElementRequestBody.builder() \
                    .content(content) \
                    .sequence(self.seq + 1) \
                    .build()
                req = ContentCardElementRequest.builder() \
                    .card_id(self.card_id) \
                    .element_id(elem_id) \
                    .request_body(body) \
                    .build()
                resp = await loop.run_in_executor(
                    None, self.gw.lark.cardkit.v1.card_element.content, req)
                if not resp.success():
                    log.error("cardkit element 更新失败 %s: %s", elem_id, resp.msg)
                    ok = False
                self.seq += 1
            except Exception as e:  # noqa: BLE001
                log.error("cardkit element 更新异常 %s: %s", elem_id, e)
                ok = False
        if not ok:
            self._degrade()

    def _degrade(self) -> None:
        """cardkit 更新失败：降级——后续终态用纯文本发一条收尾消息。"""
        if not self.degraded:
            self.degraded = True

    async def send_final_text(self) -> None:
        """降级收尾：把当前状态与回答用纯文本补发（仅 degraded 时调用）。"""
        if not self.degraded:
            return
        parts = [f"**{self.title}**\n{self.status_text}"]
        if self.reply_text:
            parts.append(self.reply_text[:1500])
        try:
            await self.gw.send_text(self.chat_id, "\n\n".join(parts))
        except Exception:  # noqa: BLE001
            pass


# ────────────── 卡片管理器（gateway 持有）：task_id → card ──────────────

class CardManager:
    def __init__(self, gw) -> None:  # noqa: ANN001
        self.gw = gw
        self.cards: dict[str, StreamingCard] = {}  # task_id/round_key → card

    def get(self, key: str) -> StreamingCard | None:
        return self.cards.get(key)

    def register(self, key: str, card: StreamingCard) -> None:
        self.cards[key] = card

    def drop(self, key: str) -> None:
        self.cards.pop(key, None)

    def keys_for_workspace(self, workspace_id: str) -> list[str]:
        return [k for k, c in self.cards.items() if c.task_id == k]
