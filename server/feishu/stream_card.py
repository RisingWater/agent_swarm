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
    CreateCardElementRequest,
    CreateCardElementRequestBody,
    CreateCardRequest,
    CreateCardRequestBody,
    DeleteCardElementRequest,
    DeleteCardElementRequestBody,
    UpdateCardElementRequest,
    UpdateCardElementRequestBody,
)

from . import commands

log = logging.getLogger("nexus-feishu")

THROTTLE_S = 2.5
ELEM_STATUS = "reply_status"
ELEM_REPLY = "reply_text"
ELEM_DETAILS = "reply_details"
ELEM_DETAILS_CONTENT = "reply_details_body"
ELEM_ACTIONS = "reply_actions"

EMPTY_REPLY_PLACEHOLDER = "_⏳ 等待 agent 回复_"

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
        self._fail_streak = 0  # 连续渲染失败计数（瞬时网络抖动容忍 2 次）
        # 视图状态
        self.status_text = "⏳ 已受理"
        self.reply_text = ""
        self._tool_states: dict[str, tuple[str, str, str]] = {}  # callId → (name, state, detail)
        self.reasoning_text = ""  # 中间思路快照（折叠面板）
        self.actions: list[dict] = []
        self.header_template = RUNNING_TEMPLATES["queued"]
        self._dirty = asyncio.Event()
        self._loop_task: asyncio.Task | None = None
        self._last_render = 0.0
        self._actions_sig = ""
        # 已渲染快照（内容不变不调 cardkit，减少调用量是防 degraded 的关键）
        self._rendered = {"status": "", "reply": "", "details": ""}
        self._details_present = False
        self._actions_present = True  # open 时 actions 若在 schema 里则视为已存在

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
        if "🔄" not in self._details_md():
            self._dirty.set()

    def set_reasoning(self, text: str) -> None:
        """中间思路快照（折叠面板 section，对齐 opencode-feishu setReasoningSnapshot）。"""
        text = (text or "").strip()
        if not text:
            return
        if text == self.reasoning_text:
            return
        self.reasoning_text = text
        self.status_text = "⏳ 正在生成回复"
        self._dirty.set()

    def append_tool(self, line: str) -> None:
        # 兼容旧调用（不带 callId）：塞进匿名槽位
        self.set_tool(f"anon-{len(self._tool_states)}", line, "running", "")

    def set_tool(self, call_id: str, name: str, state_: str, detail: str = "") -> None:
        """按 callId 维护工具状态 map（running → completed 原地翻新，对齐 opencode-feishu）。

        相同 (name, state, detail) 的重复事件不置 dirty（插件 part 事件会重放多次，
        减少 cardkit 调用是防 degraded 的关键——参考 opencode-feishu debounce 设计）。
        """
        if not call_id:
            call_id = f"anon-{len(self._tool_states)}"
        if self._tool_states.get(call_id) == (name, state_, detail):
            return
        self._tool_states[call_id] = (name, state_, detail)
        self.status_text = "⏳ 正在生成回复"
        self._dirty.set()

    def _render_tools(self) -> list[str]:
        """工具区 markdown 行：✅/❌/⚙️ + 工具名 + 命令摘要，稳定顺序按首次出现。"""
        lines = []
        for call_id, (name, state_, detail) in self._tool_states.items():
            icon = {"completed": "✅", "error": "❌"}.get(state_, "⚙️")
            line = f"{icon} {name}" + (f"：{detail}" if detail else "")
            lines.append(line)
        return lines[-12:]

    def set_reply(self, full_text: str) -> None:
        if full_text and full_text != self.reply_text:
            self.reply_text = full_text
            self._dirty.set()

    def set_actions(self, actions: list[dict]) -> None:
        sig = json.dumps(actions, ensure_ascii=False)
        if sig == self._actions_sig:
            return
        self._actions_sig = sig
        self.actions = actions
        self._dirty.set()

    def finish(self, state_: str, detail: str = "") -> None:
        self.header_template = TERMINAL_TEMPLATES.get(state_, "grey")
        label = {"completed": "✅ 已完成", "failed": "❌ 已失败", "canceled": "⛔ 已中断"}.get(state_, state_)
        self.status_text = f"{label}" + (f" · {detail}" if detail else "")
        self.actions = []
        # 终态：details 里的 running 图标全部落为 completed（对齐 opencode-feishu 终态映射）
        self._tool_states = {
            cid: (n, "completed" if s == "running" else s, d)
            for cid, (n, s, d) in self._tool_states.items()
        }
        self._dirty.set()

    # ────────────── 渲染（对齐 opencode-feishu result-card-view） ──────────────

    def _schema(self) -> dict:
        elements = [
            _md_element(ELEM_STATUS, self._status_md()),
            _md_element(ELEM_REPLY, self._reply_md()),
        ]
        details = self._details_element()
        if details is not None:
            elements.append(details)
            self._details_present = True
        actions = self._actions_element()
        if actions is not None:
            elements.append(actions)
            self._actions_present = True
        return {
            "schema": "2.0",
            "config": {"streaming_mode": True, "wide_screen_mode": True},
            "header": {
                "title": {"tag": "plain_text", "content": self.title[:72]},
                "template": self.header_template,
            },
            "body": {"elements": elements},
        }

    def _status_md(self) -> str:
        return f"**状态**\n{self.status_text}"

    def _reply_md(self) -> str:
        return self.reply_text[:2800] if self.reply_text else EMPTY_REPLY_PLACEHOLDER

    def _details_md(self) -> str:
        """折叠面板内容：中间思路 + 工具进度 sections（opencode-feishu buildDetailsMarkdown）。"""
        sections = []
        if self.reasoning_text:
            icon = "✅" if self.reply_text else "🔄"
            sections.append(f"### {icon} 中间思路\n\n{self.reasoning_text[:1500]}")
        if self._tool_states:
            icon = "❌" if any(s == "error" for _, s, _ in self._tool_states.values()) \
                else ("🔄" if any(s == "running" for _, s, _ in self._tool_states.values()) else "✅")
            body = "**工具进度**\n" + "\n".join(f"- {l}" for l in self._render_tools())
            sections.append(f"### {icon} 执行过程\n\n{body}")
        return "\n\n---\n\n".join(sections)

    def _details_element(self) -> dict | None:
        content = self._details_md()
        if not content:
            return None
        return {
            "tag": "collapsible_panel",
            "element_id": ELEM_DETAILS,
            "expanded": False,
            "header": {"title": {"tag": "plain_text", "content": "详细步骤"}},
            "elements": [_md_element(ELEM_DETAILS_CONTENT, content)],
        }

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
        """增量渲染：status/reply 走 element content，details 折叠面板走 add/replace/delete，
        actions 增删走 add/delete（opencode-feishu renderDetails/renderActions 同款）。
        内容快照去重：不变的内容不调 cardkit。"""
        if not self.card_id or self.degraded:
            return
        loop = asyncio.get_running_loop()
        ok = True

        async def _content(elem_id: str, md_text: str, snap_key: str) -> None:
            nonlocal ok
            if self._rendered.get(snap_key) == md_text:
                return
            try:
                # sequence 必填（自增，幂等去重用），缺省报 99992402
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
                if not resp.success():
                    log.error("cardkit element 更新失败 %s: %s", elem_id, resp.msg)
                    ok = False
                else:
                    self._rendered[snap_key] = md_text
                self.seq += 1
            except Exception as e:  # noqa: BLE001
                # 网络/SSL 抖动等瞬时异常：不更新快照，下轮重试；连续 3 轮失败才降级
                log.warning("cardkit element 更新异常 %s: %s", elem_id, e)
                ok = False

        # 1. 状态 + 回答正文
        await _content(ELEM_STATUS, self._status_md(), "status")
        await _content(ELEM_REPLY, self._reply_md(), "reply")

        # 2. details 折叠面板（中间思路/工具进度）：动态增/换/删
        details_md = self._details_md()
        details_el = self._details_element()
        if details_md and details_el is not None:
            if self._rendered.get("details") != details_md:
                try:
                    if not self._details_present:
                        # 面板首次出现：append（若无按钮区则加在末尾；有则插到按钮前）
                        body = CreateCardElementRequestBody.builder() \
                            .type("append") \
                            .elements(json.dumps([details_el], ensure_ascii=False)) \
                            .sequence(self.seq + 1) \
                            .build()
                        req = CreateCardElementRequest.builder() \
                            .card_id(self.card_id) \
                            .request_body(body).build()
                        resp = await loop.run_in_executor(
                            None, self.gw.lark.cardkit.v1.card_element.create, req)
                        if resp.success():
                            self._details_present = True
                            self._rendered["details"] = details_md
                        else:
                            log.error("cardkit addElement 失败: %s", resp.msg)
                            ok = False
                        self.seq += 1
                    else:
                        # 面板已存在：整面板 replace（collapsible_panel 不支持 content 直更）
                        body = UpdateCardElementRequestBody.builder() \
                            .element(json.dumps(details_el, ensure_ascii=False)) \
                            .sequence(self.seq + 1) \
                            .build()
                        req = UpdateCardElementRequest.builder() \
                            .card_id(self.card_id) \
                            .element_id(ELEM_DETAILS) \
                            .request_body(body).build()
                        resp = await loop.run_in_executor(
                            None, self.gw.lark.cardkit.v1.card_element.update, req)
                        if resp.success():
                            self._rendered["details"] = details_md
                        else:
                            log.error("cardkit replaceElement 失败: %s", resp.msg)
                            ok = False
                        self.seq += 1
                except Exception as e:  # noqa: BLE001
                    log.warning("cardkit details 更新异常: %s", e)
                    ok = False
        elif self._details_present and not details_md:
            try:
                body = DeleteCardElementRequestBody.builder() \
                    .sequence(self.seq + 1).build()
                req = DeleteCardElementRequest.builder() \
                    .card_id(self.card_id) \
                    .element_id(ELEM_DETAILS) \
                    .request_body(body).build()
                resp = await loop.run_in_executor(
                    None, self.gw.lark.cardkit.v1.card_element.delete, req)
                if resp.success():
                    self._details_present = False
                    self._rendered["details"] = ""
                else:
                    log.error("cardkit deleteElement 失败: %s", resp.msg)
                    ok = False
                self.seq += 1
            except Exception as e:  # noqa: BLE001
                log.warning("cardkit details 删除异常: %s", e)
                ok = False

        # 3. actions 按钮区：动态增/删（状态翻转靠按钮 value 不变，无需 replace）
        actions_el = self._actions_element()
        if actions_el is not None and not self._actions_present:
            try:
                body = CreateCardElementRequestBody.builder() \
                    .type("append") \
                    .elements(json.dumps([actions_el], ensure_ascii=False)) \
                    .sequence(self.seq + 1) \
                    .build()
                req = CreateCardElementRequest.builder() \
                    .card_id(self.card_id) \
                    .request_body(body).build()
                resp = await loop.run_in_executor(
                    None, self.gw.lark.cardkit.v1.card_element.create, req)
                if resp.success():
                    self._actions_present = True
                else:
                    log.error("cardkit addActions 失败: %s", resp.msg)
                    ok = False
                self.seq += 1
            except Exception as e:  # noqa: BLE001
                log.warning("cardkit actions 添加异常: %s", e)
                ok = False
        elif actions_el is None and self._actions_present:
            try:
                body = DeleteCardElementRequestBody.builder() \
                    .sequence(self.seq + 1).build()
                req = DeleteCardElementRequest.builder() \
                    .card_id(self.card_id) \
                    .element_id(ELEM_ACTIONS) \
                    .request_body(body).build()
                resp = await loop.run_in_executor(
                    None, self.gw.lark.cardkit.v1.card_element.delete, req)
                if resp.success():
                    self._actions_present = False
                else:
                    log.error("cardkit deleteActions 失败: %s", resp.msg)
                    ok = False
                self.seq += 1
            except Exception as e:  # noqa: BLE001
                log.warning("cardkit actions 删除异常: %s", e)
                ok = False

        if not ok:
            self._fail_streak += 1
            if self._fail_streak >= 3:
                log.error("cardkit 连续 %s 轮更新失败，降级纯文本: %s", self._fail_streak, self.title)
                self._degrade()
        else:
            self._fail_streak = 0

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
