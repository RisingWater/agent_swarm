# -*- coding: utf-8 -*-
"""规划器控制通道测试：`/ws/planner` + `/api/planner/*` + `planner_state` 缓存/迁移。

用 FastAPI TestClient 起真实 ASGI（**不进入 lifespan**，避免拉起 mcp/渠道网关）。
鉴权用 conftest 的 u-test / apikey=ak-test；工作区用 ws 夹具（w-test）。
"""
import time

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from server import db as dbmod
from server import models
from server.db import engine
from server.main import app
from server.planner_channel import planner_conns, _ops

from tests.conftest import as_user, ws, user  # noqa: F401  共享夹具

APIKEY = "ak-test"


def _auth(key: str = APIKEY) -> dict:
    return {"Authorization": f"Bearer {key}"}


@pytest.fixture()
def client():
    planner_conns.clear()
    _ops.clear()
    c = TestClient(app)
    yield c
    c.close()
    planner_conns.clear()
    _ops.clear()


def _wait_offline(client, wid: str) -> bool:
    for _ in range(20):
        if client.get(f"/api/planner/{wid}/state", headers=_auth()).json()["online"] is False:
            return True
        time.sleep(0.05)
    return False


def test_planner_state_cache_and_op_roundtrip(client, ws):
    wid = ws.id
    # 未连接：offline、空快照
    b = client.get(f"/api/planner/{wid}/state", headers=_auth()).json()
    assert b["online"] is False and b["goals"] == [] and b["tasks"] == []

    with client.websocket_connect("/ws/planner") as wsc:
        wsc.send_json({"type": "hello", "apikey": APIKEY, "workspace_id": wid})
        assert wsc.receive_json()["type"] == "hello_ok"

        # 推状态快照 → upsert
        wsc.send_json({"type": "state", "payload": {
            "workspace_id": wid,
            "updated_at": "2026-10-03T00:00:00Z",
            "goals": [{"id": "g1", "title": "目标一", "status": "planning",
                       "plan_status": "draft", "expert_workspace_id": "w-expert",
                       "expert_name": "专家WS", "progress": {"done": 1, "total": 3}}],
            "tasks": [{"id": "t1", "goal_id": "g1", "title": "任务一",
                       "status": "pending", "depends_on": [], "acceptance_type": "manual"},
                      {"id": "t2", "goal_id": "g1", "title": "任务二",
                       "status": "waiting_expert", "depends_on": ["t1"], "acceptance_type": "expert"}],
        }})
        wsc.send_json({"type": "ping"})  # ping/pong 同步：确保 state 帧已落库
        assert wsc.receive_json()["type"] == "pong"

        b = client.get(f"/api/planner/{wid}/state", headers=_auth()).json()
        assert b["online"] is True
        assert b["updated_at"] == "2026-10-03T00:00:00Z"
        assert b["goals"][0]["id"] == "g1" and b["tasks"][0]["title"] == "任务一"
        # 拆解审批状态原样透传（前端按 draft/approved 展示徽标并门控 plan.approve）
        assert b["goals"][0]["plan_status"] == "draft"
        # 专家工作区字段透传
        assert b["goals"][0]["expert_workspace_id"] == "w-expert"
        assert b["goals"][0]["expert_name"] == "专家WS"
        # 专家验收点：acceptance_type=expert + status=waiting_expert 原样透传
        expert_task = next(t for t in b["tasks"] if t["id"] == "t2")
        assert expert_task["acceptance_type"] == "expert" and expert_task["status"] == "waiting_expert"

        # 下发操作 → core 侧收到 op 帧
        r = client.post(f"/api/planner/{wid}/op", headers=_auth(),
                        json={"op": "goal.nudge", "payload": {"goal_id": "g1"}})
        assert r.status_code == 200
        op_id = r.json()["op_id"]
        frame = wsc.receive_json()
        assert frame["type"] == "op" and frame["op"] == "goal.nudge"
        assert frame["op_id"] == op_id and frame["payload"]["goal_id"] == "g1"

        # 回执 → 操作历史
        wsc.send_json({"type": "op_result", "op_id": op_id, "ok": True, "error": ""})
        wsc.send_json({"type": "ping"})
        assert wsc.receive_json()["type"] == "pong"
        ops = client.get(f"/api/planner/{wid}/ops", headers=_auth()).json()["ops"]
        assert ops and ops[-1]["op_id"] == op_id and ops[-1]["ok"] is True

    # 断开后回到 offline
    assert _wait_offline(client, wid)


def test_planner_ws_hello_errors(client, ws):
    with client.websocket_connect("/ws/planner") as wsc:
        wsc.send_json({"type": "hello", "apikey": "bad-key", "workspace_id": ws.id})
        assert wsc.receive_json()["type"] == "hello_err"
    with client.websocket_connect("/ws/planner") as wsc:
        wsc.send_json({"type": "hello", "apikey": APIKEY, "workspace_id": "does-not-exist"})
        assert wsc.receive_json()["type"] == "hello_err"


def test_planner_op_validation_and_offline(client, ws):
    wid = ws.id
    # core 离线 → 409
    assert client.post(f"/api/planner/{wid}/op", headers=_auth(),
                       json={"op": "state.get", "payload": {}}).status_code == 409
    # 缺 op → 422
    assert client.post(f"/api/planner/{wid}/op", headers=_auth(),
                       json={"payload": {}}).status_code == 422
    # 未鉴权 → 401
    assert client.get(f"/api/planner/{wid}/state").status_code == 401


def test_planner_ownership_404(client, ws):
    with Session(engine) as s:
        if s.get(models.User, "u-plan-intruder") is None:
            s.add(models.User(
                id="u-plan-intruder", username="plan-intruder",
                password_hash=models.hash_password("pw"),
                api_key_hash=models.hash_api_key("ak-plan-intruder"),
                api_key="ak-plan-intruder",
            ))
            s.commit()
    # 非属主访问别人的规划器工作区 → 404（不泄露存在性）
    assert client.get(f"/api/planner/{ws.id}/state",
                      headers=_auth("ak-plan-intruder")).status_code == 404
    assert client.post(f"/api/planner/{ws.id}/op", headers=_auth("ak-plan-intruder"),
                       json={"op": "state.get", "payload": {}}).status_code == 404


def test_planner_state_table_and_migrate_idempotent():
    dbmod._migrate()
    dbmod._migrate()  # 幂等
    with engine.connect() as conn:
        names = {r[0] for r in conn.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type='table'")}
    assert "planner_state" in names
    # 缓存读写在迁移后的表上可用
    from server.planner_channel import save_state, load_state

    save_state("w-mig-test", {"goals": [{"id": "g"}]})
    payload, _ = load_state("w-mig-test")
    assert payload["goals"][0]["id"] == "g"
