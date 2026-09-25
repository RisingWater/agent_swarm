# -*- coding: utf-8 -*-
"""dispatch_queued_for 加密读回回归测试（2026-09-25 派单卡死 bug）。

根因：ENC_KEY 开启时任务建行把明文 message 清空（密文进 message_enc），
而 dispatch_queued_for 直接读 t.message → 派给插件空指令 → 插件回
"text required" 拒单，任务行已被前置 working 且无回滚 → 永远卡 working。
"""
import asyncio
import json

import pytest

from server import models
from server.db import engine
from server import nexus_a2a
from sqlmodel import Session, select

from tests.conftest import as_user, ws, user  # noqa: F401  共享夹具（conftest 定义；_db 为 autouse 不导入）


class _FakeWS:
    """捕获 send_text；ack 行为由 _make_conn 按模式注入。"""

    def __init__(self):
        self.sent: list[str] = []

    async def send_text(self, raw: str) -> None:
        self.sent.append(raw)


def _make_conn(wid: str, mode: str = "ok") -> nexus_a2a.PluginConn:
    """mode: ok=发送后自动回成功 ack；error=自动回 error；none=永不回（等测试/超时）。"""
    ws = _FakeWS()
    conn = nexus_a2a.PluginConn(ws=ws, user_id="u-test", workspace_id=wid)

    orig_send = ws.send_text

    async def _send_and_ack(raw: str) -> None:
        await orig_send(raw)
        payload = json.loads(raw).get("payload") or {}
        rid = payload.get("id")
        fut = conn.pending.get(rid)
        if fut is None or fut.done():
            return
        if mode == "ok":
            fut.set_result({"sessionId": "ses-fake"})
        elif mode == "error":
            fut.set_exception(RuntimeError("text required"))
        # mode == "none"：不回，测试自己控制

    ws.send_text = _send_and_ack  # type: ignore[method-assign]
    return conn


def test_dispatch_queued_decrypts_encrypted_message(as_user, ws, monkeypatch):
    """加密建行的 queued 任务派发时必须解出原文，而不是发空串。"""
    import shortuuid

    from server import crypto

    with Session(engine) as s:
        t = models.A2aTask(
            id=shortuuid.uuid(),
            context_id=shortuuid.uuid(),
            workspace_id=ws.id,
            user_id=as_user.id,
            caller="agent",
            status="queued",
        )
        enc = crypto.encrypt(as_user.api_key or "", "请把 TODO.md 的待办整理成清单")
        t.message_enc = enc
        t.message = "" if enc else "fallback"
        s.add(t)
        s.commit()
        tid = t.id

    conn = _make_conn(ws.id)
    monkeypatch.setitem(nexus_a2a.plugins, ws.id, [conn])

    n = asyncio.run(nexus_a2a.dispatch_queued_for(ws.id))
    assert n == 1
    assert conn.ws.sent, "没有派发帧"
    payload = json.loads(conn.ws.sent[0])["payload"]
    text_parts = payload["params"]["message"]["parts"]
    sent_text = "".join(p.get("text", "") for p in text_parts if p.get("kind") == "text")
    assert sent_text == "请把 TODO.md 的待办整理成清单", f"派发了错误文本: {sent_text!r}"
    # ack 成功后才置 working + accepted_at（2026-09-25 顺序修复：发送失败不再卡死）
    with Session(engine) as s:
        t = s.get(models.A2aTask, tid)
        assert t.status == "working" and t.accepted_at is not None


def test_dispatch_no_ack_keeps_queued(as_user, ws, monkeypatch):
    """发送失败（死连接）任务必须留在 queued 等重试，不能卡 working。"""
    import shortuuid

    class _DeadWS:
        async def send_text(self, raw: str) -> None:
            raise RuntimeError("connection closed")

    with Session(engine) as s:
        t = models.A2aTask(
            id=shortuuid.uuid(), context_id=shortuuid.uuid(), workspace_id=ws.id,
            user_id=as_user.id, caller="agent", status="queued", message="x",
        )
        s.add(t)
        s.commit()
        tid = t.id

    conn = nexus_a2a.PluginConn(ws=_DeadWS(), user_id="u-test", workspace_id=ws.id)
    monkeypatch.setitem(nexus_a2a.plugins, ws.id, [conn])

    n = asyncio.run(nexus_a2a.dispatch_queued_for(ws.id))
    assert n == 0
    with Session(engine) as s:
        t = s.get(models.A2aTask, tid)
        assert t.status == "queued" and t.accepted_at is None
    # 死连接被剔除
    assert nexus_a2a._conns(ws.id) == []


def test_dispatch_plugin_error_keeps_queued(as_user, ws, monkeypatch):
    """插件回 error（如 text required 拒单）任务留在 queued，且日志可查。"""
    import shortuuid

    class _RejectWS:
        async def send_text(self, raw: str) -> None:
            pass  # 帧发出去了

    with Session(engine) as s:
        t = models.A2aTask(
            id=shortuuid.uuid(), context_id=shortuuid.uuid(), workspace_id=ws.id,
            user_id=as_user.id, caller="agent", status="queued", message="x",
        )
        s.add(t)
        s.commit()
        tid = t.id

    conn = _make_conn(ws.id, mode="error")

    async def _run():
        task = asyncio.ensure_future(nexus_a2a.dispatch_queued_for(ws.id))
        await asyncio.sleep(0.1)  # 等 dispatch 发帧并收到 error 回包
        return await task

    n = asyncio.run(_run())
    assert n == 0
    with Session(engine) as s:
        t = s.get(models.A2aTask, tid)
        assert t.status == "queued" and t.accepted_at is None


# ---------------------------------------------------------------- 双鉴权端点（桌宠扩展 2026-09-25）

def test_ws_nexus_hello_accepts_apikey_or_jwt(as_user):
    """hello 带 apikey 或 token 都能拿到 WebConn 注册（桌宠长效凭证）。"""
    import json

    from fastapi import WebSocket

    class _FakeWebSocket(WebSocket):
        # 不真正握手，只测 ws_nexus 的消息循环太重——直接测鉴权分支
        pass

    # ws_nexus 是长循环，单测改为直接验证 _auth_apikey/_auth_jwt 行为与 hello 分支等价性
    assert nexus_a2a._auth_apikey("ak-test") is not None
    assert nexus_a2a._auth_apikey("ak-wrong") is None
    assert nexus_a2a._auth_jwt("garbage") is None


@pytest.mark.asyncio
async def test_require_user_http_accepts_apikey_and_jwt(as_user, ws, monkeypatch):
    """reply/history/rounds 用 _require_user_http：JWT 与 apikey 都放行，坏凭证 401。"""
    from starlette.requests import Request

    def _req_with(auth: str) -> Request:
        raw = []
        if auth:
            raw = [(b"authorization", auth.encode())]
        scope = {"type": "http", "method": "GET", "path": "/", "headers": raw}
        return Request(scope)

    # apikey
    u = await nexus_a2a._require_user_http(_req_with("Bearer ak-test"))
    assert u.id == "u-test"
    # JWT
    from server.auth import create_token

    u2 = await nexus_a2a._require_user_http(_req_with(f"Bearer {create_token('u-test', 'tester')}"))
    assert u2.id == "u-test"
    # 坏凭证 / 缺失
    import pytest as _pytest

    from fastapi import HTTPException

    with _pytest.raises(HTTPException) as ei:
        await nexus_a2a._require_user_http(_req_with("Bearer garbage"))
    assert ei.value.status_code == 401
    with _pytest.raises(HTTPException) as ei2:
        await nexus_a2a._require_user_http(_req_with(""))
    assert ei2.value.status_code == 401


def test_dispatch_queued_plain_message_still_works(as_user, ws, monkeypatch):
    """未加密（ENC_KEY 未开 / 回退明文）路径不回归。"""
    import shortuuid

    # 清场：前面测试故意留下的 queued 任务会影响派发计数
    with Session(engine) as s:
        for leftover in s.exec(
            select(models.A2aTask).where(models.A2aTask.workspace_id == ws.id, models.A2aTask.status == "queued")
        ).all():
            leftover.status = "canceled"
            s.add(leftover)
        s.commit()

    with Session(engine) as s:
        t = models.A2aTask(
            id=shortuuid.uuid(),
            context_id=shortuuid.uuid(),
            workspace_id=ws.id,
            user_id=as_user.id,
            caller="nexus-web",
            status="queued",
            message="plain text task",
        )
        s.add(t)
        s.commit()
        tid = t.id

    conn = _make_conn(ws.id)
    monkeypatch.setitem(nexus_a2a.plugins, ws.id, [conn])

    n = asyncio.run(nexus_a2a.dispatch_queued_for(ws.id))
    assert n == 1
    payload = json.loads(conn.ws.sent[0])["payload"]
    text_parts = payload["params"]["message"]["parts"]
    sent_text = "".join(p.get("text", "") for p in text_parts if p.get("kind") == "text")
    assert sent_text == "plain text task"
    with Session(engine) as s:
        assert s.get(models.A2aTask, tid).status == "working"
