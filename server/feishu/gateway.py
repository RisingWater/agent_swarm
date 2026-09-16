"""飞书网关：lark-oapi WS 长连接（SDK 独立线程）→ 主 asyncio loop 桥接。

- 消息事件：/swarm 指令 + 普通文本 → commands.handle_message
- card action：select 提交（Phase 1）；后续中断/权限按钮（Phase 3）
- 发送走 lark Client（im.v1.message.create），同步调用放 executor
- 群聊仅响应 @bot 的消息
"""
import asyncio
import base64
import json
import logging
from typing import Any, Awaitable, Callable

import lark_oapi as lark
from lark_oapi.api.im.v1 import (
    CreateMessageRequest,
    CreateMessageRequestBody,
    P2ImMessageReceiveV1,
)
from lark_oapi.event.callback.model.p2_card_action_trigger import (
    CallBackToast,
    P2CardActionTrigger,
    P2CardActionTriggerResponse,
)
from lark_oapi.ws import Client as LarkWsClient
from lark_oapi.ws import client as lark_ws
from lark_oapi.ws.const import (
    HEADER_MESSAGE_ID,
    HEADER_SEQ,
    HEADER_SUM,
    HEADER_TYPE,
)

from . import cards, commands, state

log = logging.getLogger("nexus-feishu")


class _CardAwareWsClient(LarkWsClient):
    """补上 CARD 帧处理（SDK 的 Client 只分发 EVENT；card.action.trigger 走 CARD 帧）。"""

    async def _handle_data_frame(self, frame: Any) -> None:  # noqa: ANN401
        from lark_oapi.ws.client import JSON, MessageType, Response, UTF_8, _get_by_key

        hs = frame.headers
        msg_id = _get_by_key(hs, HEADER_MESSAGE_ID)
        sum_ = int(_get_by_key(hs, HEADER_SUM) or 1)
        seq = int(_get_by_key(hs, HEADER_SEQ) or 0)
        type_ = _get_by_key(hs, HEADER_TYPE)

        pl = frame.payload
        if sum_ > 1:
            pl = self._combine(msg_id, sum_, seq, pl)
            if pl is None:
                return

        message_type = MessageType(type_)
        resp = Response(code=200)
        try:
            if message_type in (MessageType.EVENT, MessageType.CARD):
                result = self._event_handler._do_without_validation(pl)
            else:
                return
            if result is not None:
                resp.data = base64.b64encode(JSON.marshal(result).encode(UTF_8))
        except Exception as e:  # noqa: BLE001
            log.error("处理 WS 帧失败 type=%s: %s", message_type.value, e)
            resp = Response(code=500)
        frame.payload = JSON.marshal(resp).encode(UTF_8)
        await self._write_message(frame.SerializeToString())


class FeishuGateway:
    def __init__(self, app_id: str, app_secret: str) -> None:
        self.app_id = app_id
        self.app_secret = app_secret
        self._main_loop: asyncio.AbstractEventLoop | None = None
        self._ws: LarkWsClient | None = None
        self.lark = lark.Client.builder().app_id(app_id).app_secret(app_secret).build()

    # ────────────── 生命周期 ──────────────

    async def start(self) -> None:
        self._main_loop = asyncio.get_running_loop()
        from . import bridge

        bridge.bind_gateway(self)
        handler = lark.EventDispatcherHandler.builder("", "") \
            .register_p2_im_message_receive_v1(self._bridge(lambda d: self._on_message(d))) \
            .register_p2_card_action_trigger(self._bridge_card(lambda d: self._on_card_action(d))) \
            .build()

        def run_ws() -> None:
            # lark_oapi.ws.client 在**模块导入时**绑定了导入线程的 event loop 全局引用
            # （`loop = asyncio.get_event_loop()`）；uvicorn+uvloop 下那是主线程正在跑的
            # loop，子线程 start() 的 run_until_complete 直接撞
            # "this event loop is already running"。子线程里新建独立 loop 并替换
            # SDK 模块级引用，start() 的全部 await 都落在这个新 loop 上。
            import asyncio as _asyncio
            import lark_oapi.ws.client as _lark_ws

            ws_loop = _asyncio.new_event_loop()
            _asyncio.set_event_loop(ws_loop)
            _lark_ws.loop = ws_loop

            client = _CardAwareWsClient(
                self.app_id,
                self.app_secret,
                event_handler=handler,
                log_level=lark.LogLevel.INFO,
            )
            self._ws = client
            log.info("飞书 WS 长连接启动（app_id=%s…）", self.app_id[:8])
            client.start()

        import threading

        threading.Thread(target=run_ws, name="feishu-ws", daemon=True).start()

    def stop(self) -> None:
        # SDK 未暴露优雅关闭：daemon 线程随进程退出即可；解除事件桥
        try:
            from . import bridge

            bridge.unbind_gateway()
        except Exception:  # noqa: BLE001
            pass
        log.info("飞书网关停止（随进程）")

    # ────────────── 线程→loop 桥 ──────────────

    def _bridge(self, coro_factory: Callable[[Any], Awaitable[None]]):
        def run(*args: Any) -> None:  # noqa: ANN002
            loop = self._main_loop
            if loop is None or loop.is_closed():
                log.error("主事件循环不可用，事件被丢弃")
                return None
            asyncio.run_coroutine_threadsafe(coro_factory(*args), loop)
            return None
        return run

    def _bridge_card(self, coro_factory: Callable[[Any], Awaitable[Any]]):
        def run(*args: Any) -> Any:  # noqa: ANN002
            loop = self._main_loop
            if loop is None or loop.is_closed():
                return P2CardActionTriggerResponse()
            fut = asyncio.run_coroutine_threadsafe(coro_factory(*args), loop)
            try:
                return fut.result(timeout=2.5)
            except Exception as e:  # noqa: BLE001
                log.error("卡片回调处理失败: %s", e)
                return P2CardActionTriggerResponse()
        return run

    # ────────────── 发送（executor 同步调用 SDK） ──────────────

    async def send_text(self, chat_id: str, text: str) -> None:
        req = CreateMessageRequest.builder() \
            .receive_id_type("chat_id") \
            .request_body(CreateMessageRequestBody.builder()
                          .receive_id(chat_id)
                          .msg_type("text")
                          .content(cards.text_payload(text))
                          .build()) \
            .build()
        resp = await asyncio.get_running_loop().run_in_executor(
            None, self.lark.im.v1.message.create, req)
        if not resp.success():
            log.error("发送文本失败 chat=%s: %s", chat_id, resp.msg)

    async def send_card(self, chat_id: str, card: dict) -> None:
        req = CreateMessageRequest.builder() \
            .receive_id_type("chat_id") \
            .request_body(CreateMessageRequestBody.builder()
                          .receive_id(chat_id)
                          .msg_type("interactive")
                          .content(cards.card_payload(card))
                          .build()) \
            .build()
        resp = await asyncio.get_running_loop().run_in_executor(
            None, self.lark.im.v1.message.create, req)
        if not resp.success():
            log.error("发送卡片失败 chat=%s: %s", chat_id, resp.msg)

    # ────────────── 事件处理 ──────────────

    @staticmethod
    def _extract_text(content: str) -> str:
        try:
            obj = json.loads(content)
            return str(obj.get("text", ""))
        except Exception:  # noqa: BLE001
            return ""

    @staticmethod
    def _mentions(content: str, raw_event: dict) -> bool:
        """群里需要 @bot；mentions 解析失败退回「有 mention 就响应」。"""
        msg = (raw_event.get("event") or {}).get("message") or {}
        return bool(msg.get("mentions"))

    async def _on_message(self, data: P2ImMessageReceiveV1) -> None:
        try:
            event = data.event
            if not event or not event.message:
                return
            msg = event.message
            chat_id = msg.chat_id or ""
            chat_type = msg.chat_type or "p2p"
            open_id = (event.sender.sender_id.open_id or "") if event.sender else ""
            text = self._extract_text(msg.content or "")

            raw_event = {"event": {"message": {"mentions": getattr(msg, "mentions", None) or []}}}
            if chat_type == "group" and not self._mentions(msg.content or "", raw_event):
                return

            log.info("飞书消息 chat=%s type=%s sender=%s text=%r", chat_id, chat_type, open_id, text[:40])
            await commands.handle_message(
                chat_id, chat_type, open_id, text,
                send_text=self.send_text, send_card=self.send_card,
            )
        except Exception:  # noqa: BLE001
            log.exception("处理飞书消息失败")

    async def _on_card_action(self, data: P2CardActionTrigger) -> P2CardActionTriggerResponse:
        """卡片交互：select form 提交 / 中断 / 权限提问应答。

        SDK 已把 action.value 解析为 Dict（按钮构造时必须给原生 object 而非 json 字符串）。
        form 提交（select）走 action.form_value + 按钮 name 的 btn_submit_<formName> 约定。
        """
        try:
            event = data.event
            action = event.action or None
            value: dict = {}
            if action is not None and isinstance(action.value, dict):
                value = dict(action.value)
            form = (action.form_value if action else None) or {}
            if not isinstance(form, dict):
                form = {}
            operator = (event.operator.open_id or "") if event.operator else ""
            chat_id = (event.context.open_chat_id or "") if event.context else ""

            # 1) form 提交（选择工作区）：按钮 name = btn_submit_ws_select
            if action is not None and (action.name or "").startswith("btn_submit_"):
                form_name = action.name[len("btn_submit_"):]
                if form_name == "ws_select":
                    selected = str(form.get("workspace_select", "") or "")
                    if not selected:
                        return self._toast("请先在下拉中选择工作区")
                    ws_name, ws_type = await self._handle_select_submit(chat_id, operator, selected)
                    if ws_name is None:
                        return P2CardActionTriggerResponse()  # 错误已由 _handle_select_submit 发文本
                    return self._card_response({
                        "config": {"wide_screen_mode": True},
                        "header": {
                            "template": "green",
                            "title": {"tag": "plain_text", "content": "已选择工作区"},
                        },
                        "elements": [{
                            "tag": "div",
                            "text": {"tag": "lark_md",
                                     "content": (f"✅ 已选中：**{ws_name}**（{ws_type or '未知类型'}）\n"
                                                 "直接发文本即可派任务；`/swarm monitor on` 开启实时同步。")},
                        }],
                    })
                return self._toast("已提交")

            # 2) 普通按钮（value 内 action 字段路由）
            act = value.get("action", "")
            if act == "abort":
                await self._handle_abort(value, operator, chat_id)
                return self._toast("中断请求已发送")
            if act == "feishu_reply":
                await self._handle_card_reply(value, operator, chat_id)
                return self._toast("已应答")
            if act == "reply_hint":
                return self._toast("直接在输入框发送回答即可")
        except Exception:  # noqa: BLE001
            log.exception("处理卡片回调失败")
        return P2CardActionTriggerResponse()

    @staticmethod
    def _card_response(card: dict) -> P2CardActionTriggerResponse:
        """回调返回新卡片：原卡整体替换（按钮灰掉/状态收尾的推荐姿势）。"""
        from lark_oapi.event.callback.model.p2_card_action_trigger import CallBackCard

        resp = P2CardActionTriggerResponse()
        resp.card = CallBackCard({"type": "raw", "data": card})
        return resp

    @staticmethod
    def _toast(content: str) -> P2CardActionTriggerResponse:
        resp = P2CardActionTriggerResponse()
        resp.toast = CallBackToast({"type": "success", "content": content[:20]})
        return resp

    async def _handle_abort(self, value: dict, open_id: str, chat_id: str) -> None:
        """中断按钮：复用 A2A tasks/cancel 链路（后台任务 kill 进程树，前台标 canceled）。"""
        from . import bridge

        user_id = state.user_id_by_open_id(open_id)
        if not user_id:
            return
        task_id = str(value.get("taskId", ""))
        if not task_id:
            return
        try:
            from server.nexus_a2a import cancel_task_by_id

            ok = await cancel_task_by_id(task_id, user_id)
        except Exception as e:  # noqa: BLE001
            log.error("中断任务失败 %s: %s", task_id[:8], e)
            ok = False
        rc = bridge.manager().get(task_id)
        if rc is not None:
            rc.abort_result(ok)

    async def _handle_card_reply(self, value: dict, open_id: str, chat_id: str) -> None:
        """权限/提问按钮应答：走与 web reply 相同的 DataPart 链路。"""
        from . import bridge

        user_id = state.user_id_by_open_id(open_id)
        if not user_id:
            return
        task_id = str(value.get("taskId", ""))
        reply = str(value.get("reply", ""))
        if not task_id or not reply:
            return
        # 任务属主校验
        from server.db import engine
        from sqlmodel import Session
        from server import models

        with Session(engine) as session:
            task = session.get(models.A2aTask, task_id)
            if task is None:
                return
            ws = session.get(models.Workspace, task.workspace_id) if task.workspace_id else None
            if ws is None or ws.user_id != user_id:
                await self.send_text(chat_id, "❌ 无权应答该任务。")
                return
        try:
            from server.nexus_a2a import reply_task_from_feishu

            ok, msg = await reply_task_from_feishu(task_id, reply, str(value.get("requestId", "")))
        except Exception as e:  # noqa: BLE001
            log.error("卡片应答失败 %s: %s", task_id[:8], e)
            ok, msg = False, str(e)
        if not ok:
            await self.send_text(chat_id, f"❌ 应答失败：{msg}")
            return
        rc = bridge.manager().get(task_id)
        if rc is not None:
            rc.set_round_buttons([])

    async def _handle_select_submit(self, chat_id: str, open_id: str, workspace_id: str) -> tuple[str | None, str]:
        """处理选择提交。返回 (工作区名, 类型)；失败返回 (None, "")（错误已发文本）。"""
        if not chat_id or not open_id or not workspace_id:
            return None, ""
        user_id = state.user_id_by_open_id(open_id)
        if not user_id:
            await self.send_text(chat_id, "请先 `/swarm bind as_xxx` 绑定账号再选择工作区。")
            return None, ""
        from . import workspaces as ws_mod

        ws = ws_mod.get_own_workspace(user_id, workspace_id)
        if ws is None:
            await self.send_text(chat_id, "❌ 该工作区不存在或不属于你。")
            return None, ""
        state.update_chat(chat_id, "p2p", user_id, workspace_id=workspace_id)
        return ws.name, ws.agent_type or ""
