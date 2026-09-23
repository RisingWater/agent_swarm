r"""iLink Bot 协议 HTTP 客户端（对齐 OpenClaw Weixin 2.4.6）+ 每用户会话管理器。

协议参考 D:\wangxu\work\weixin-ClawBot-API（bot.py / weixin-openclaw-api-py-docs.md）：
- POST 头：AuthorizationType ilink_bot_token + 随机 X-WECHAT-UIN + iLink-App-* + Bearer token
- 业务体带 base_info {channel_version, bot_agent}；HTTP 200 不代表成功，必须校验 ret/errcode
- 登录：get_bot_qrcode?bot_type=3 → get_qrcode_status 轮询（wait/scaned/need_verifycode/
  scaned_but_redirect→切节点/confirmed→bot_token+baseurl+ilink_bot_id）
- 收消息：getupdates 长轮询（hold ~35s，get_updates_buf 游标，ret=-14 = token 失效需重扫）
- 发消息：sendmessage（message_type=2 BOT，message_state=2 FINISH，必须带 context_token）
"""
import asyncio
import base64
import json
import logging
import secrets
import time
from urllib.parse import quote

import httpx
from sqlmodel import Session

from server import crypto, models
from server.db import engine

log = logging.getLogger("nexus-weixin")

BASE_URL = "https://ilinkai.weixin.qq.com"
CHANNEL_VERSION = "2.4.6"
CLIENT_VERSION = "132102"  # (2 << 16) | (4 << 8) | 6
BOT_AGENT = "agent-swarm-nexus-weixin/1.0.0 (python)"
API_TIMEOUT = 15.0
QR_STATUS_TIMEOUT = 40.0  # get_qrcode_status 服务端 hold ~35s
MAX_LONG_POLL = 40.0
STALE_TOKEN_CODE = -14


class ILinkError(RuntimeError):
    def __init__(self, message: str, *, ret: int | None = None, errcode: int | None = None):
        super().__init__(message)
        self.ret = ret
        self.errcode = errcode

    @property
    def stale_token(self) -> bool:
        return STALE_TOKEN_CODE in (self.ret, self.errcode)


def _headers(token: str | None) -> dict:
    uin = str(secrets.randbits(32))
    h = {
        "Content-Type": "application/json",
        "AuthorizationType": "ilink_bot_token",
        "X-WECHAT-UIN": base64.b64encode(uin.encode()).decode(),
        "iLink-App-Id": "bot",
        "iLink-App-ClientVersion": CLIENT_VERSION,
    }
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def _base_info() -> dict:
    return {"channel_version": CHANNEL_VERSION, "bot_agent": BOT_AGENT}


def _check_business(data: dict, path: str) -> dict:
    """HTTP 200 ≠ 成功：校验 JSON 可解析 + ret/errcode。"""
    if not isinstance(data, dict):
        raise ILinkError(f"{path}: non-dict response")
    ret = data.get("ret")
    errcode = data.get("errcode")
    if ret not in (None, 0) or errcode not in (None, 0):
        raise ILinkError(
            f"{path}: ret={ret} errcode={errcode} {data.get('errmsg') or data.get('message') or ''}".strip(),
            ret=ret if isinstance(ret, int) else None,
            errcode=errcode if isinstance(errcode, int) else None,
        )
    return data


async def _post(client: httpx.AsyncClient, path: str, body: dict, token: str | None,
                base_url: str = "", timeout: float = API_TIMEOUT) -> dict:
    url = f"{base_url or BASE_URL}/{path.lstrip('/')}"
    rsp = await client.post(url, json=body, headers=_headers(token), timeout=timeout)
    if rsp.status_code != 200:
        raise ILinkError(f"{path}: HTTP {rsp.status_code}")
    try:
        data = rsp.json()
    except ValueError as e:
        raise ILinkError(f"{path}: invalid JSON") from e
    return _check_business(data, path)


async def _get(client: httpx.AsyncClient, path: str, token: str | None,
               base_url: str = "", timeout: float = API_TIMEOUT) -> dict:
    url = f"{base_url or BASE_URL}/{path.lstrip('/')}"
    rsp = await client.get(url, headers=_headers(token) if token else {
        "iLink-App-Id": "bot", "iLink-App-ClientVersion": CLIENT_VERSION,
    }, timeout=timeout)
    if rsp.status_code != 200:
        raise ILinkError(f"{path}: HTTP {rsp.status_code}")
    try:
        data = rsp.json()
    except ValueError as e:
        raise ILinkError(f"{path}: invalid JSON") from e
    return _check_business(data, path)


async def fetch_login_qrcode(client: httpx.AsyncClient) -> dict:
    """申请登录二维码。返回 {qrcode, qrcode_img_content(HTTPS 链接), ...}。"""
    data = await _post(client, "ilink/bot/get_bot_qrcode?bot_type=3",
                       {"local_token_list": [], "base_info": _base_info()}, None, timeout=None)
    if not data.get("qrcode"):
        raise ILinkError("get_bot_qrcode: no qrcode in response")
    return data


async def poll_qrcode_status(client: httpx.AsyncClient, qrcode: str, base_url: str = "",
                             verify_code: str = "") -> dict:
    """轮询扫码状态（服务端 hold ~35s）。返回原始 dict（status 字段判断分支）。"""
    ep = f"ilink/bot/get_qrcode_status?qrcode={quote(qrcode, safe='')}"
    if verify_code:
        ep += f"&verify_code={quote(verify_code, safe='')}"
    try:
        return await _get(client, ep, None, base_url, timeout=QR_STATUS_TIMEOUT)
    except httpx.TimeoutException:
        return {"status": "wait"}


def _client_id() -> str:
    return f"agent-swarm-weixin:{int(time.time() * 1000)}-{secrets.token_hex(4)}"


async def send_text(client: httpx.AsyncClient, token: str, base_url: str, to_user_id: str,
                    context_token: str, text: str) -> None:
    """发送文本消息（FINISH 完整消息）。context_token 必须来自该用户最近入站消息。"""
    body = {
        "msg": {
            "from_user_id": "",
            "to_user_id": to_user_id,
            "client_id": _client_id(),
            "message_type": 2,
            "message_state": 2,
            "context_token": context_token,
            "item_list": [{"type": 1, "text_item": {"text": text[:4000]}}],
        },
        "base_info": _base_info(),
    }
    data = await _post(client, "ilink/bot/sendmessage", body, token, base_url)
    _check_business(data, "sendmessage")


async def send_tool_items(client: httpx.AsyncClient, token: str, base_url: str, to_user_id: str,
                          context_token: str, items: list[dict]) -> None:
    """发送官方 tool_call item（type 11/12，2.4.4+；普通客户端显示效果待实测）。"""
    body = {
        "msg": {
            "from_user_id": "",
            "to_user_id": to_user_id,
            "client_id": _client_id(),
            "message_type": 2,
            "message_state": 2,
            "context_token": context_token,
            "item_list": items[:5],
        },
        "base_info": _base_info(),
    }
    data = await _post(client, "ilink/bot/sendmessage", body, token, base_url)
    _check_business(data, "sendmessage(tool)")


async def getconfig(client: httpx.AsyncClient, token: str, base_url: str, user_id: str,
                    context_token: str) -> dict:
    """取账号配置 + typing_ticket（发"正在输入"用）。"""
    body = {"to_user_id": user_id, "context_token": context_token, "base_info": _base_info()}
    return await _post(client, "ilink/bot/getconfig", body, token, base_url)


# ---------------------------------------------------------------- 每用户会话管理器


class UserSession:
    """一个用户的 ClawBot 会话：长轮询收消息 + 状态回写 DB。

    生命周期：start() 起 asyncio task；token 失效（-14）置 need_relogin 并退出循环；
    stop() 取消。服务重启后由 start_all() 恢复。
    """

    def __init__(self, user_id: str):
        self.user_id = user_id
        self.task: asyncio.Task | None = None
        self.client: httpx.AsyncClient | None = None
        self._stop = False
        # 内存态（DB 为准，这里缓存热路径）
        self.token = ""
        self.baseurl = ""
        self.wx_user_id = ""
        self.cursor = ""
        self.context_token = ""

    def load(self) -> bool:
        """从 DB 读登录态；返回是否有可用 token。"""
        with Session(engine) as s:
            row = s.get(models.WeixinLogin, self.user_id)
            if row is None:
                return False
            self.token = crypto.decrypt(_user_key(s, self.user_id), row.token_enc, row.bot_token)
            self.baseurl = row.baseurl or BASE_URL
            self.wx_user_id = row.wx_user_id
            self.cursor = row.cursor_buf or ""
            self.context_token = row.context_token or ""
            return bool(self.token)

    def save(self, **fields) -> None:
        with Session(engine) as s:
            row = s.get(models.WeixinLogin, self.user_id)
            if row is None:
                return
            key = _user_key(s, self.user_id)
            if "token" in fields:
                enc = crypto.encrypt(key, fields.pop("token"))
                row.token_enc = enc
                row.bot_token = "" if enc else fields.pop("bot_token", "")
            if "status" in fields:
                row.status = fields.pop("status")
            for k, v in fields.items():
                setattr(row, k, v)
            row.updated_at = models.utcnow()
            s.add(row)
            s.commit()

    async def run(self) -> None:
        """getupdates 长轮询主循环。"""
        self._stop = False
        self.client = httpx.AsyncClient()
        try:
            backoff = 2.0
            poll_timeout = 36.0
            while not self._stop:
                try:
                    data = await _post(
                        self.client, "ilink/bot/getupdates",
                        {"get_updates_buf": self.cursor, "base_info": _base_info()},
                        self.token, self.baseurl, timeout=poll_timeout,
                    )
                    backoff = 2.0
                    new_cursor = data.get("get_updates_buf")
                    if isinstance(new_cursor, str) and new_cursor and new_cursor != self.cursor:
                        self.cursor = new_cursor
                        self.save(cursor_buf=new_cursor)
                    suggested = data.get("longpolling_timeout_ms")
                    try:
                        if suggested and float(suggested) > 0:
                            poll_timeout = max(1.0, min(MAX_LONG_POLL, float(suggested) / 1000.0 + 1.0))
                    except (TypeError, ValueError):
                        pass
                    for msg in data.get("msgs") or []:
                        await self._handle_msg(msg)
                except ILinkError as exc:
                    if exc.stale_token:
                        log.info("user %s weixin token 失效（-14），需重新扫码", self.user_id)
                        self.save(status="need_relogin")
                        from . import bridge
                        await bridge.notify_relogin_needed(self)
                        return
                    log.warning("weixin getupdates error: %s", exc)
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 60.0)
                except asyncio.CancelledError:
                    raise
                except Exception:  # noqa: BLE001
                    log.exception("weixin session loop crash")
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 60.0)
        finally:
            await self.client.aclose()
            self.client = None

    async def _handle_msg(self, msg: dict) -> None:
        import json as _json

        from . import bridge

        log.debug("weixin msg raw: %s", _json.dumps(msg, ensure_ascii=False)[:400])
        if msg.get("message_type") != 1:  # 只处理用户消息
            log.debug("weixin msg skipped: message_type=%s", msg.get("message_type"))
            return
        ctx = str(msg.get("context_token", "") or "")
        from_id = str(msg.get("from_user_id", "") or "")
        if ctx:
            self.context_token = ctx
            self.save(context_token=ctx, context_at=models.utcnow())
        # 隐私兜底：只处理本人消息（非本人发给自有 bot 的忽略）
        if self.wx_user_id and from_id and from_id != self.wx_user_id:
            log.info("weixin msg from non-owner %s ignored (self=%s)", from_id[:16], self.wx_user_id[:16])
            return
        text = ""
        for item in msg.get("item_list") or []:
            if item.get("type") == 1:
                text = str((item.get("text_item") or {}).get("text", "") or "")
                break
        log.debug("weixin inbound text=%r from=%s", text[:50], from_id[:16])
        if not text:
            from . import commands

            await commands.reply_text(self, "（暂只支持文字消息，图片/语音/文件还不认识哦）")
            return
        from . import commands

        await commands.handle_inbound(self, text)

    async def start(self) -> None:
        if self.task and not self.task.done():
            return
        self.task = asyncio.create_task(self.run())

    async def stop(self) -> None:
        self._stop = True
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self.task = None


def _user_key(session: Session, user_id: str) -> str:
    from server import models as m

    u = session.get(m.User, user_id)
    return (u.api_key or "") if u else ""


# 模块级会话注册表：user_id → UserSession
_sessions: dict[str, UserSession] = {}


def get_session_mgr(user_id: str) -> UserSession:
    sess = _sessions.get(user_id)
    if sess is None:
        sess = UserSession(user_id)
        _sessions[user_id] = sess
    return sess


def peek_session(user_id: str) -> UserSession | None:
    return _sessions.get(user_id)


async def start_all() -> None:
    """服务启动：恢复所有已有 token 的会话（engine 就绪后调用）。"""
    from sqlmodel import select

    with Session(engine) as s:
        rows = s.exec(select(models.WeixinLogin)).all()
        user_ids = [row.user_id for row in rows if row.status in ("online", "connecting")]
    # await 放会话外（与 2026-09-23 连接池事故同一约定）
    for uid in user_ids:
        sess = get_session_mgr(uid)
        if sess.load():
            await sess.start()
            log.info("weixin session resumed for user %s", uid)


async def stop_all() -> None:
    for sess in list(_sessions.values()):
        await sess.stop()
