"""微信 ClawBot 登录/状态 API（web 账号页用；JWT 鉴权）。

- POST /api/weixin/login/start      申请二维码（服务端起轮询任务）
- GET  /api/weixin/login/status     当前登录流程状态（前端 1.5s 短轮询）
- POST /api/weixin/login/verify     提交数字配对码
- POST /api/weixin/login/cancel     取消本次扫码
- GET  /api/weixin/status           登录态概览（bot 账号/状态/窗口设置）
- POST /api/weixin/logout           断开并清除 token
- PUT  /api/weixin/settings         选中工作区/monitor/brief
"""
import asyncio
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session

from server import crypto, models
from server.auth import get_current_user
from server.db import engine, get_session
from server.weixin import gateway, state as wx_state

router = APIRouter(prefix="/api/weixin", tags=["weixin"])

# 进行中的扫码流程：user_id → {qrcode, img, base_url, task, result, status, message}
_flows: dict[str, dict] = {}
_FLOW_TTL = 600.0


def _gc_flows() -> None:
    now = time.time()
    for uid, f in list(_flows.items()):
        if now - f["ts"] > _FLOW_TTL:
            _flows.pop(uid, None)


class VerifyBody(BaseModel):
    code: str


def _status_out(uid: str) -> dict:
    row = wx_state.get_login(uid)
    flow = _flows.get(uid)
    out: dict = {
        "flow": None if not flow else {
            "status": flow["status"],          # wait / scanned / need_verifycode / confirmed / error / expired
            "qrcode_img": flow["img"],
            "message": flow["message"],
        },
        "logged_in": bool(row and row.bot_token) or (row is not None and row.status == "online"),
    }
    if row is not None:
        out.update({
            "wx_user_id": row.wx_user_id,
            "wx_bot_id": row.wx_bot_id,
            "status": row.status,
            "logged_at": row.logged_at.isoformat() + "Z" if row.logged_at else None,
            "workspace_id": row.workspace_id or "",
            "monitor_on": bool(row.monitor_on),
            "brief_on": bool(row.brief_on),
        })
    return out


def _qrcode_data_uri(content: str) -> str:
    """iLink 返回的 qrcode_img_content 实际是 HTTPS 链接（liteapp.weixin.qq.com），
    不是图片——服务端渲染成 PNG data URI，前端 <img> 直出。"""
    import base64
    import io

    import qrcode

    img = qrcode.make(content)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


@router.post("/login/start")
async def login_start(user: models.User = Depends(get_current_user)):
    """申请二维码并后台轮询状态。"""
    _gc_flows()
    if user.id in _flows:
        return _status_out(user.id)  # 已有进行中的流程，直接复用
    import httpx

    client = httpx.AsyncClient()
    try:
        qr = await gateway.fetch_login_qrcode(client)
    except gateway.ILinkError as exc:
        await client.aclose()
        raise HTTPException(502, f"获取二维码失败：{exc}")
    except Exception:
        await client.aclose()
        raise
    # qrcode_img_content 可能是链接（需本地渲染）也可能是 base64 图片；统一转 data URI
    raw = str(qr.get("qrcode_img_content") or qr["qrcode"] or "")
    if raw.startswith("http"):
        img = _qrcode_data_uri(raw)
    elif raw.startswith("data:"):
        img = raw
    elif raw.startswith("iVBOR"):  # 裸 base64 PNG
        img = "data:image/png;base64," + raw
    else:
        img = _qrcode_data_uri(raw)
    flow = {
        "qrcode": qr["qrcode"],
        "img": img,
        "base_url": gateway.BASE_URL,
        "client": client,
        "task": None,
        "result": None,
        "status": "wait",
        "message": "请用微信扫码登录（扫完你的微信号就成为本平台的 ClawBot）",
        "ts": time.time(),
    }
    flow["task"] = asyncio.create_task(_poll_flow(user.id, flow))
    _flows[user.id] = flow
    return _status_out(user.id)


@router.get("/login/status")
async def login_status(user: models.User = Depends(get_current_user)):
    return _status_out(user.id)


@router.post("/login/verify")
async def login_verify(body: VerifyBody, user: models.User = Depends(get_current_user)):
    flow = _flows.get(user.id)
    if flow is None:
        raise HTTPException(404, "没有进行中的扫码流程")
    flow["verify_code"] = body.code.strip()
    flow["status"] = "wait"
    flow["message"] = "配对码已提交，请在手机上确认"
    return {"ok": True}


@router.post("/login/cancel")
async def login_cancel(user: models.User = Depends(get_current_user)):
    flow = _flows.pop(user.id, None)
    if flow:
        t = flow.get("task")
        if t:
            t.cancel()
        await _close_flow(user.id, flow)
    return {"ok": True}


async def _poll_flow(uid: str, flow: dict) -> None:
    """后台轮询扫码状态直到 confirmed/过期/取消。"""
    verify = ""
    try:
        while True:
            f = _flows.get(uid)
            if f is not flow:
                return
            try:
                data = await gateway.poll_qrcode_status(flow["client"], flow["qrcode"], flow["base_url"], verify)
            except gateway.ILinkError as exc:
                if exc.stale_token:
                    pass
                else:
                    flow["message"] = "轮询异常，重试中"
                await asyncio.sleep(2)
                continue
            st = str(data.get("status", ""))
            if st == "confirmed" or data.get("bot_token"):
                await _apply_confirmed(uid, data, flow)
                return
            if st == "scaned_but_redirect":
                host = str(data.get("redirect_host") or "")
                if host:
                    flow["base_url"] = host if host.startswith("http") else f"https://{host}"
                continue
            if st in ("need_verifycode",):
                flow["status"] = "need_verifycode"
                flow["message"] = "需要数字配对码：请查看微信并在下方输入"
                # 等用户提交配对码
                while flow.get("verify_code") is None and _flows.get(uid) is flow:
                    await asyncio.sleep(0.5)
                verify = flow.pop("verify_code", "")
                continue
            if st == "scaned":
                flow["status"] = "scanned"
                flow["message"] = "已扫码，请在手机上确认"
            if st == "expired":
                await _close_flow(uid, flow)
                return
            await asyncio.sleep(0.5)
    except asyncio.CancelledError:
        await _close_flow(uid, flow)
    except Exception:  # noqa: BLE001
        import logging

        logging.getLogger("nexus-weixin").exception("weixin login flow crash")
        flow["status"] = "error"
        flow["message"] = "二维码状态查询失败，请点「重新获取二维码」"
        await _close_flow(uid, flow)


async def _close_flow(uid: str, flow: dict) -> None:
    """终态收尾：清注册表 + 关闭扫码轮询用的 httpx client。"""
    if _flows.get(uid) is flow:
        _flows.pop(uid, None)
    client = flow.get("client")
    if client is not None:
        try:
            await client.aclose()
        except Exception:  # noqa: BLE001
            pass


async def _apply_confirmed(uid: str, data: dict, flow: dict) -> None:
    """登录成功：持久化 token（加密落库）+ 起会话循环。"""
    token = str(data.get("bot_token") or "")
    bot_id = str(data.get("ilink_bot_id") or "")
    wx_user = str(data.get("ilink_user_id") or "")
    baseurl = str(data.get("baseurl") or data.get("base_url") or flow["base_url"] or gateway.BASE_URL)
    with Session(engine) as s:
        row = s.get(models.WeixinLogin, uid)
        key = ""
        u = s.get(models.User, uid)
        key = (u.api_key or "") if u else ""
        enc = crypto.encrypt(key, token)
        if row is None:
            row = models.WeixinLogin(user_id=uid)
            s.add(row)
        row.wx_bot_id = bot_id
        row.wx_user_id = wx_user
        row.baseurl = baseurl
        row.token_enc = enc
        row.bot_token = "" if enc else token
        row.cursor_buf = ""
        row.context_token = ""
        row.status = "online"
        row.logged_at = models.utcnow()
        row.updated_at = models.utcnow()
        s.add(row)
        s.commit()
    flow["client_close"] = True
    _flows.pop(uid, None)
    await _close_flow(uid, flow)  # confirmed 是终态：清流程关 client，前端切已登录视图（不再显示二维码）
    sess = gateway.get_session_mgr(uid)
    sess.load()
    await sess.start()
    from . import bridge

    bridge.bind_listener()


@router.get("/status")
async def status(user: models.User = Depends(get_current_user)):
    return _status_out(user.id)


@router.post("/logout")
async def logout(user: models.User = Depends(get_current_user)):
    sess = gateway.peek_session(user.id)
    if sess:
        await sess.stop()
    state.update(user.id, status="offline", token="", bot_token="")
    return {"ok": True}


class SettingsBody(BaseModel):
    workspace_id: str | None = None
    monitor_on: bool | None = None
    brief_on: bool | None = None


@router.put("/settings")
async def update_settings(body: SettingsBody, user: models.User = Depends(get_current_user),
                          session: Session = Depends(get_session)):
    row = wx_state.get_login(user.id)
    if row is None:
        raise HTTPException(404, "尚未登录微信 ClawBot")
    if body.workspace_id is not None:
        if body.workspace_id:
            ws = session.get(models.Workspace, body.workspace_id)
            if ws is None or ws.user_id != user.id:
                raise HTTPException(404, "工作区不存在或不属于当前账号")
        wx_state.update_ws_settings(user.id, workspace_id=body.workspace_id)
    wx_state.update_ws_settings(user.id, monitor_on=body.monitor_on, brief_on=body.brief_on)
    return _status_out(user.id)
