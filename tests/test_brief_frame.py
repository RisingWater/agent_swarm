# -*- coding: utf-8 -*-
"""终态事件 brief 摘要测试（2026-09-25 桌宠派单 5pbzfAjo）。

status-update completed/failed 与监控轮 idle 的 web 推送帧附带 brief 字段
（artifact 截 1600 / error 截 700），只拼内存副本不改持久化形状——桌宠等
WS 订阅者拿不到任务行明文，靠这个做飞书同级简报卡。
"""
import asyncio
import json

import pytest

from server import models, nexus_a2a
from server.db import engine
from sqlmodel import Session

from tests.conftest import as_user, ws, user  # noqa: F401


class _CollectWS:
    def __init__(self):
        self.sent: list[str] = []

    async def send_text(self, raw: str) -> None:
        self.sent.append(raw)


@pytest.fixture()
def sub(_clean_registry=None):
    """订阅 ws 工作区的假连接（逐测试独立）。"""
    conn = nexus_a2a.WebConn(ws=_CollectWS(), user_id="u-test")
    nexus_a2a.subscribers.setdefault("w-test", set()).add(conn)
    conn.workspace_id = "w-test"
    yield conn
    nexus_a2a.subscribers.clear()
    nexus_a2a.all_subscribers.clear()


def _make_task(tid: str, status: str, artifact: str = "", error: str = "") -> None:
    from server import crypto

    with Session(engine) as s:
        enc_a = crypto.encrypt("ak-test", artifact) if artifact else ""
        enc_e = crypto.encrypt("ak-test", error) if error else ""
        s.add(models.A2aTask(
            id=tid, context_id="c", workspace_id="w-test", user_id="u-test",
            caller="agent", status=status,
            artifact_enc=enc_a or None, artifact="" if enc_a else (artifact or None),
            error_enc=enc_e or None, error="" if enc_e else (error or None),
        ))
        s.commit()


def _status_frames(conn) -> list[dict]:
    """从收到的全部帧里筛出 type=event 的 status-update 帧。"""
    out = []
    for x in conn.ws.sent:
        f = json.loads(x)
        if f.get("type") == "event" and (f.get("payload") or {}).get("kind") == "status-update":
            out.append(f["payload"])
    return out


@pytest.mark.asyncio
async def test_completed_status_frame_has_brief_artifact(as_user, ws, sub):
    _make_task("t-brief-1", "completed", artifact="最终回答全文" * 300)  # 1800 字符 >1600 截断
    event = {"kind": "status-update", "taskId": "t-brief-1", "status": {"state": "completed"}}
    await nexus_a2a.handle_plugin_event("w-test", event)
    frames = _status_frames(sub)
    assert frames, "没有 status 帧"
    frame = frames[-1]
    # 原 event 字段保留 + brief 附加（截 1600）
    assert frame["taskId"] == "t-brief-1"
    assert frame["brief"]["artifact"].startswith("最终回答全文")
    assert len(frame["brief"]["artifact"]) == 1600


@pytest.mark.asyncio
async def test_failed_status_frame_has_brief_error(as_user, ws, sub):
    _make_task("t-brief-2", "failed", error="执行出错了" * 200)  # 1200 字符 >700 截断
    event = {"kind": "status-update", "taskId": "t-brief-2", "status": {"state": "failed"}}
    await nexus_a2a.handle_plugin_event("w-test", event)
    frames = _status_frames(sub)
    assert frames
    frame = frames[-1]
    assert frame["brief"]["error"].startswith("执行出错了")
    assert len(frame["brief"]["error"]) == 700


@pytest.mark.asyncio
async def test_working_frame_has_no_brief(as_user, ws, sub):
    """非终态流式帧不带 brief（验收项）。"""
    _make_task("t-brief-3", "working")
    event = {"kind": "status-update", "taskId": "t-brief-3", "status": {"state": "working"}}
    await nexus_a2a.handle_plugin_event("w-test", event)
    frame = json.loads(sub.ws.sent[0])
    assert "brief" not in frame


@pytest.mark.asyncio
async def test_persistence_shape_unchanged(as_user, ws, sub):
    """落库的 a2a_events 不含 brief（只内存拼接——验收项：不改持久化形状）。"""
    from sqlmodel import select

    _make_task("t-brief-4", "completed", artifact="回答")
    event = {"kind": "status-update", "taskId": "t-brief-4", "status": {"state": "completed"}}
    await nexus_a2a.handle_plugin_event("w-test", event)
    with Session(engine) as s:
        row = s.exec(
            select(models.A2aEvent).where(models.A2aEvent.task_id == "t-brief-4")
        ).first()
        assert row is not None
        import sqlite3

        assert "brief" not in row.payload  # 明文列（未加密时）不含 brief


@pytest.mark.asyncio
async def test_monitor_idle_frame_has_brief(as_user, ws, sub):
    """监控轮 idle 帧带 artifact 摘要。"""
    from server import crypto

    with Session(engine) as s:
        art = "监控轮最终回答" * 50
        s.add(models.A2aTask(
            id="mon-brief-x", context_id="", workspace_id="w-test", user_id="u-test",
            caller="monitor", status="completed",
            artifact_enc=crypto.encrypt("ak-test", art), artifact="",
        ))
        s.commit()
    payload = {"roundKey": "mon-brief-x", "type": "idle", "sessionId": "ses-x"}
    await nexus_a2a.handle_monitor_event("w-test", payload)
    idle_frames = [json.loads(x) for x in sub.ws.sent if json.loads(x).get("type") == "monitor"]
    assert idle_frames, "没有 monitor 帧"
    assert idle_frames[-1]["payload"]["brief"]["artifact"].startswith("监控轮最终回答")
