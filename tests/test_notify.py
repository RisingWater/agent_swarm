"""跨工作区长任务完成提醒（2026-09-30）。

场景：agent1 派任务给 agent2，agent2 跑很久，agent1 失去耐心收轮。
任务终态后延时检查：结果未被取走 + 发起方前台轮已收尾 → 推极简提醒。
"""
import asyncio
from datetime import datetime, timezone

import pytest
from sqlmodel import Session

from server import models
from server.db import engine
from server.nexus_a2a import (
    _notify_caller_if_abandoned,
    _results_delivered,
    dispatchable,
    mark_result_delivered,
)


@pytest.fixture()
def two_workspaces(as_user):
    """发起方 w-a（agent1）与执行方 w-b（agent2）。"""
    with Session(engine) as s:
        for wid, name in (("w-a", "caller"), ("w-b", "executor")):
            if s.get(models.Workspace, wid) is None:
                s.add(models.Workspace(
                    id=wid, user_id=as_user.id, name=name, path=f"/tmp/{wid}",
                    status="online",
                    last_heartbeat=datetime.now(timezone.utc).replace(tzinfo=None),
                ))
        s.commit()


def _mk_task(task_id: str, status: str, from_ws: str = "w-a", to_ws: str = "w-b") -> None:
    with Session(engine) as s:
        t = models.A2aTask(
            id=task_id, context_id=task_id, workspace_id=to_ws,
            user_id="u-test", caller="agent", from_workspace_id=from_ws, status=status,
        )
        t.message = "帮我看一下"
        s.add(t)
        s.commit()


def test_delivered_result_skips_notify(two_workspaces):
    _mk_task("tk-d1", "completed")
    mark_result_delivered("tk-d1")
    asyncio.run(_notify_caller_if_abandoned("tk-d1"))
    with Session(engine) as s:
        rows = s.query(models.A2aTask).filter(models.A2aTask.caller == "nexus-notify").all()
    assert all("tk-d1" not in (t.message or "") for t in rows)


def test_non_terminal_skips_notify(two_workspaces):
    _mk_task("tk-w1", "working")
    asyncio.run(_notify_caller_if_abandoned("tk-w1"))
    # 没建提醒任务（不在终态）
    with Session(engine) as s:
        rows = s.query(models.A2aTask).filter(
            models.A2aTask.caller == "nexus-notify",
            models.A2aTask.workspace_id == "w-a",
        ).all()
    assert not rows


def test_abandoned_completed_notifies_once(two_workspaces, monkeypatch):
    # 调用方无活跃监控轮 = 已收轮（失去耐心）
    _mk_task("tk-n1", "completed")
    asyncio.run(_notify_caller_if_abandoned("tk-n1"))
    from server import crypto

    with Session(engine) as s:
        rows = s.query(models.A2aTask).filter(
            models.A2aTask.caller == "nexus-notify",
            models.A2aTask.workspace_id == "w-a",
        ).all()
    assert len(rows) == 1
    text = crypto.decrypt("ak-test", rows[0].message_enc, rows[0].message)
    assert "tk-n1" in text
    assert "a2a_task" in text
    # 第二次不重复（_notified_tasks 防重）
    _results_delivered.discard("tk-n1")
    asyncio.run(_notify_caller_if_abandoned("tk-n1"))
    with Session(engine) as s:
        rows = s.query(models.A2aTask).filter(
            models.A2aTask.caller == "nexus-notify",
            models.A2aTask.workspace_id == "w-a",
        ).all()
    assert len(rows) == 1


def test_caller_still_working_skips_notify(two_workspaces):
    # 发起方有活跃监控轮（working）= 还在等 → 不打扰
    _mk_task("tk-n2", "completed")
    with Session(engine) as s:
        s.add(models.A2aTask(
            id="mon-w-a", context_id="mon-w-a", workspace_id="w-a",
            user_id="u-test", caller="monitor", status="working",
        ))
        s.commit()
    asyncio.run(_notify_caller_if_abandoned("tk-n2"))
    with Session(engine) as s:
        rows = s.query(models.A2aTask).filter(
            models.A2aTask.caller == "nexus-notify",
            models.A2aTask.workspace_id == "w-a",
        ).all()
    assert not any("tk-n2" in (t.message or "") for t in rows)


def test_no_caller_ws_skips(two_workspaces):
    # web / 外部调用（无 from_workspace_id）不提醒
    _mk_task("tk-x1", "completed", from_ws="")
    asyncio.run(_notify_caller_if_abandoned("tk-x1"))
    with Session(engine) as s:
        rows = s.query(models.A2aTask).filter(
            models.A2aTask.caller == "nexus-notify",
        ).all()
    assert not any("tk-x1" in (t.message or "") for t in rows)
