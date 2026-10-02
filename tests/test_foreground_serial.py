# -*- coding: utf-8 -*-
"""服务端前台任务级串行（2026-10-03）：一个前台工作区同一时刻只跑一个 A2A 任务。

覆盖：`_foreground_active` 语义（前台占用 / 后台豁免 / 监控轮不算）、`dispatch_queued_for`
前台一次只派一个、活动任务未终态时不派、后台模式仍全派、终态事件 `_kick_queued` 拉下一个。
"""
import asyncio
import json
from datetime import datetime, timezone

import pytest
from sqlmodel import Session, select

from server import models, nexus_a2a
from server.db import engine

from tests.conftest import as_user, ws, user  # noqa: F401  共享夹具


@pytest.fixture(autouse=True)
def _cleanup_serial_workspaces():
    """本文件建的工作区/任务不属于共享夹具，测试后清掉，避免污染 list_workspaces 等断言。"""
    yield
    with Session(engine) as s:
        for t in s.exec(select(models.A2aTask)
                        .where(models.A2aTask.workspace_id.like("w-ser-%"))).all():
            s.delete(t)
        for w in s.exec(select(models.Workspace)
                        .where(models.Workspace.id.like("w-ser-%"))).all():
            s.delete(w)
        s.commit()


class _FakeWS:
    def __init__(self):
        self.sent: list[str] = []

    async def send_text(self, raw: str) -> None:
        self.sent.append(raw)


def _auto_ack_conn(wid: str, execution_mode: str = "foreground") -> nexus_a2a.PluginConn:
    """发送后自动回成功 ack 的假插件连接（mode=ok）。"""
    ws_ = _FakeWS()
    conn = nexus_a2a.PluginConn(ws=ws_, user_id="u-test", workspace_id=wid)
    conn.execution_mode = execution_mode
    orig = ws_.send_text

    async def _send_and_ack(raw: str) -> None:
        await orig(raw)
        payload = json.loads(raw).get("payload") or {}
        fut = conn.pending.get(payload.get("id"))
        if fut is not None and not fut.done():
            fut.set_result({"sessionId": "ses-fake"})

    ws_.send_text = _send_and_ack  # type: ignore[method-assign]
    return conn


def _mk_ws(wid: str, uid: str) -> None:
    with Session(engine) as s:
        if s.get(models.Workspace, wid) is None:
            s.add(models.Workspace(
                id=wid, user_id=uid, name=wid, path=f"/{wid}", status="online",
                # 心跳新鲜 → dispatchable（前台）；后台模式测试靠 execution_mode 豁免
                last_heartbeat=datetime.now(timezone.utc).replace(tzinfo=None),
            ))
            s.commit()


def _mk_task(wid: str, uid: str, status: str, caller: str = "agent", message: str = "m") -> str:
    import shortuuid

    with Session(engine) as s:
        t = models.A2aTask(id=shortuuid.uuid(), context_id=shortuuid.uuid(), workspace_id=wid,
                           user_id=uid, caller=caller, status=status, message=message)
        s.add(t)
        s.commit()
        return t.id


# ---------------------------------------------------------------- _foreground_active 语义

def test_foreground_active_semantics(as_user, monkeypatch):
    wid = "w-ser-a"
    _mk_ws(wid, as_user.id)
    tid = _mk_task(wid, as_user.id, "working")
    conn = _auto_ack_conn(wid, execution_mode="foreground")
    monkeypatch.setitem(nexus_a2a.plugins, wid, [conn])

    assert nexus_a2a._foreground_active(wid) is True  # 前台 + working A2A 任务

    # 后台模式豁免（即使有 working 任务也不占用）
    conn.execution_mode = "background"
    assert nexus_a2a._foreground_active(wid) is False

    # 监控轮（用户自己的 TUI 对话）不算占用
    conn.execution_mode = "foreground"
    with Session(engine) as s:
        t = s.get(models.A2aTask, tid)
        t.caller = "monitor"
        s.add(t)
        s.commit()
    assert nexus_a2a._foreground_active(wid) is False


def test_foreground_active_counts_input_required(as_user, monkeypatch):
    wid = "w-ser-b"
    _mk_ws(wid, as_user.id)
    _mk_task(wid, as_user.id, "input-required")
    monkeypatch.setitem(nexus_a2a.plugins, wid, [_auto_ack_conn(wid)])
    assert nexus_a2a._foreground_active(wid) is True


# ---------------------------------------------------------------- 派发串行

@pytest.mark.asyncio
async def test_foreground_dispatches_one_at_a_time(as_user, monkeypatch):
    wid = "w-ser-c"
    _mk_ws(wid, as_user.id)
    t1 = _mk_task(wid, as_user.id, "queued")
    t2 = _mk_task(wid, as_user.id, "queued")
    monkeypatch.setitem(nexus_a2a.plugins, wid, [_auto_ack_conn(wid)])

    n = await nexus_a2a.dispatch_queued_for(wid)
    assert n == 1
    with Session(engine) as s:
        states = sorted(s.get(models.A2aTask, t).status for t in (t1, t2))
    assert states == ["queued", "working"]  # 只派了一个，另一个仍排队

    # 已有活动任务 → 不再派发
    assert await nexus_a2a.dispatch_queued_for(wid) == 0


@pytest.mark.asyncio
async def test_foreground_no_dispatch_when_busy(as_user, monkeypatch):
    wid = "w-ser-f"
    _mk_ws(wid, as_user.id)
    _mk_task(wid, as_user.id, "working")  # 已有一个在跑
    tq = _mk_task(wid, as_user.id, "queued")
    monkeypatch.setitem(nexus_a2a.plugins, wid, [_auto_ack_conn(wid)])

    assert await nexus_a2a.dispatch_queued_for(wid) == 0
    with Session(engine) as s:
        assert s.get(models.A2aTask, tq).status == "queued"


@pytest.mark.asyncio
async def test_background_dispatches_all(as_user, monkeypatch):
    wid = "w-ser-d"
    _mk_ws(wid, as_user.id)
    _mk_task(wid, as_user.id, "queued")
    _mk_task(wid, as_user.id, "queued")
    monkeypatch.setitem(nexus_a2a.plugins, wid, [_auto_ack_conn(wid, execution_mode="background")])

    assert await nexus_a2a.dispatch_queued_for(wid) == 2  # 后台模式维持并发派发


# ---------------------------------------------------------------- 终态拉下一个

@pytest.mark.asyncio
async def test_terminal_event_kicks_queue(as_user, monkeypatch):
    wid = "w-ser-e"
    _mk_ws(wid, as_user.id)
    tid = _mk_task(wid, as_user.id, "working")
    calls = []

    async def fake_dispatch(w: str) -> int:
        calls.append(w)
        return 0

    monkeypatch.setattr(nexus_a2a, "dispatch_queued_for", fake_dispatch)
    await nexus_a2a.handle_plugin_event(
        wid, {"kind": "status-update", "taskId": tid, "status": {"state": "completed"}})
    await asyncio.sleep(0.01)  # 让 _kick_queued 调度的任务跑起来
    assert calls == [wid]
    with Session(engine) as s:
        assert s.get(models.A2aTask, tid).status == "completed"
