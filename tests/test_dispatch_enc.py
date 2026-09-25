# -*- coding: utf-8 -*-
"""dispatch_queued_for 加密读回回归测试（2026-09-25 派单卡死 bug）。

根因：ENC_KEY 开启时任务建行把明文 message 清空（密文进 message_enc），
而 dispatch_queued_for 直接读 t.message → 派给插件空指令 → 插件回
"text required" 拒单，任务行已被前置 working 且无回滚 → 永远卡 working。
"""
import asyncio
import json

from server import models
from server.db import engine
from server import nexus_a2a
from sqlmodel import Session

from tests.conftest import as_user, ws, user  # noqa: F401  共享夹具（conftest 定义；_db 为 autouse 不导入）


class _FakeWS:
    """捕获 send_text 的假 WS（不真正联网）。"""

    def __init__(self):
        self.sent: list[str] = []

    async def send_text(self, raw: str) -> None:
        self.sent.append(raw)


def _make_conn(wid: str) -> nexus_a2a.PluginConn:
    return nexus_a2a.PluginConn(ws=_FakeWS(), user_id="u-test", workspace_id=wid)


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
    # 任务行被前置 working + accepted_at（既有语义保持）
    with Session(engine) as s:
        t = s.get(models.A2aTask, tid)
        assert t.status == "working" and t.accepted_at is not None


def test_dispatch_queued_plain_message_still_works(as_user, ws, monkeypatch):
    """未加密（ENC_KEY 未开 / 回退明文）路径不回归。"""
    import shortuuid

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
