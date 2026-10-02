# -*- coding: utf-8 -*-
"""规划器角色（workspaces.role）测试：MCP workspace_add/update_info、list_workspaces、
REST 列表 / 设置，以及旧库迁移加列（幂等）。

背景（2026-10-02）：agent-swarm-planner 作为特殊工作区接入平台，需要平台侧
"planner" 标志 + 只读展示页。role 独立于 agent_type（不参与权限应答分派）。
"""
import sqlite3

import pytest
from fastapi import HTTPException
from sqlmodel import Session, select

from server import db as dbmod
from server import models, mcp_endpoint
from server.api import workspaces as ws_api
from server.db import engine

from tests.conftest import as_user, ws, user  # noqa: F401  共享夹具


def test_workspace_add_with_role(as_user):
    r = mcp_endpoint.workspace_add(path="/tmp/planner-x", name="P", role="planner")
    assert r["created"] is True and r["role"] == "planner"
    wid = r["workspace_id"]
    with Session(engine) as s:
        assert s.get(models.Workspace, wid).role == "planner"
        assert s.get(models.Workspace, wid).agent_type == "opencode"  # 不互相影响

    # list_workspaces 返回 role
    out = mcp_endpoint.list_workspaces(include_offline=True)["workspaces"]
    row = next(w for w in out if w["workspace_id"] == wid)
    assert row["role"] == "planner" and row["is_self"] is True

    # 非法角色直接拒绝，且不落库
    with pytest.raises(ValueError, match="invalid role"):
        mcp_endpoint.workspace_add(path="/tmp/planner-bad", role="boss")
    with Session(engine) as s:
        assert s.exec(
            select(models.Workspace).where(models.Workspace.path == "/tmp/planner-bad")
        ).first() is None

    # 清理（避免污染其他 list_workspaces 断言）
    mcp_endpoint.workspace_disable(workspace_id=wid)
    assert mcp_endpoint.workspace_remove(workspace_id=wid)["ok"] is True


def test_update_info_sets_role(as_user, ws):
    assert (ws.role or "agent") == "agent"
    r = mcp_endpoint.update_info(workspace_id=ws.id, role="planner")
    assert r["role"] == "planner"
    with Session(engine) as s:
        assert s.get(models.Workspace, ws.id).role == "planner"
    # 空串 = 不修改
    assert mcp_endpoint.update_info(workspace_id=ws.id)["role"] == "planner"
    # 非法拒绝
    with pytest.raises(ValueError, match="invalid role"):
        mcp_endpoint.update_info(workspace_id=ws.id, role="boss")
    # 复位，避免污染后续用例
    assert mcp_endpoint.update_info(workspace_id=ws.id, role="agent")["role"] == "agent"


def test_rest_workspace_role(user):
    with Session(engine) as s:
        created = ws_api.create_workspace(
            {"path": "/tmp/rest-planner", "name": "RP", "role": "planner"},
            user=user, session=s,
        )
        wid = created["workspace_id"]
        assert created["role"] == "planner"

        row = next(w for w in ws_api.list_workspaces(user=user, session=s) if w["id"] == wid)
        assert row["role"] == "planner"

        # 切换回 agent
        assert ws_api.set_workspace_role(wid, {"role": "agent"}, user=user, session=s)["role"] == "agent"
        row = next(w for w in ws_api.list_workspaces(user=user, session=s) if w["id"] == wid)
        assert row["role"] == "agent"

        # 非法 / 缺失角色 422
        with pytest.raises(HTTPException) as ei:
            ws_api.set_workspace_role(wid, {"role": "boss"}, user=user, session=s)
        assert ei.value.status_code == 422
        with pytest.raises(HTTPException) as ei:
            ws_api.set_workspace_role(wid, {}, user=user, session=s)
        assert ei.value.status_code == 422

        # 非属主 403
        other = s.get(models.User, "u-plan-other")
        if other is None:
            other = models.User(
                id="u-plan-other", username="plan-other",
                password_hash=models.hash_password("pw"),
                api_key_hash=models.hash_api_key("ak-plan-other"), api_key="ak-plan-other",
            )
            s.add(other)
            s.commit()
            other = s.get(models.User, "u-plan-other")
        with pytest.raises(HTTPException) as ei:
            ws_api.set_workspace_role(wid, {"role": "planner"}, user=other, session=s)
        assert ei.value.status_code == 403

        # 清理
        s.delete(s.get(models.Workspace, wid))
        s.commit()


def test_role_column_migration_is_idempotent(tmp_path, monkeypatch):
    """旧库（无 role 列）迁移后补 role=agent；重复 _migrate 幂等。"""
    p = tmp_path / "legacy.db"
    con = sqlite3.connect(p)
    con.execute("CREATE TABLE users (id TEXT PRIMARY KEY, api_key TEXT, api_key_hash TEXT)")
    con.execute("INSERT INTO users VALUES ('u1', 'ak', 'h')")
    con.execute("CREATE TABLE workspaces (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, path TEXT)")
    con.execute("INSERT INTO workspaces VALUES ('w1', 'u1', 'n', '/p')")
    con.commit()
    con.close()

    monkeypatch.setattr(dbmod, "DB_PATH", str(p))
    dbmod._migrate()
    con = sqlite3.connect(p)
    cols = {r[1] for r in con.execute("PRAGMA table_info(workspaces)")}
    assert "role" in cols
    assert con.execute("SELECT role FROM workspaces WHERE id='w1'").fetchone()[0] == "agent"
    con.close()

    # 幂等：再跑一遍不报错、值不变
    dbmod._migrate()
    con = sqlite3.connect(p)
    assert con.execute("SELECT role FROM workspaces WHERE id='w1'").fetchone()[0] == "agent"
    con.close()
