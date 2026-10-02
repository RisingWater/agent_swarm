# -*- coding: utf-8 -*-
"""调用记录 abort：`POST /api/nexus/{wid}/cancel`（JWT/apikey + 属主校验 → tasks/cancel）。"""
import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from server import models
from server.db import engine
from server.main import app

from tests.conftest import as_user, ws, user  # noqa: F401  共享夹具

APIKEY = "ak-test"


def _auth(key: str = APIKEY) -> dict:
    return {"Authorization": f"Bearer {key}"}


@pytest.fixture()
def client():
    c = TestClient(app)
    yield c
    c.close()


def _mk_task(wid: str, uid: str, status: str = "working") -> str:
    import shortuuid

    with Session(engine) as s:
        t = models.A2aTask(id=shortuuid.uuid(), context_id=shortuuid.uuid(),
                           workspace_id=wid, user_id=uid, caller="agent",
                           status=status, message="m")
        s.add(t)
        s.commit()
        return t.id


def test_cancel_aborts_active_task(client, ws):
    tid = _mk_task(ws.id, ws.user_id, status="working")
    r = client.post(f"/api/nexus/{ws.id}/cancel", headers=_auth(), json={"task_id": tid})
    assert r.status_code == 200
    assert r.json()["ok"] is True and r.json()["status"] == "canceled"
    with Session(engine) as s:
        assert s.get(models.A2aTask, tid).status == "canceled"


def test_cancel_terminal_is_idempotent_false(client, ws):
    tid = _mk_task(ws.id, ws.user_id, status="completed")
    r = client.post(f"/api/nexus/{ws.id}/cancel", headers=_auth(), json={"task_id": tid})
    assert r.status_code == 200
    assert r.json()["ok"] is False and r.json()["status"] == "completed"


def test_cancel_validation_and_auth(client, ws):
    # 缺 task_id → 422
    assert client.post(f"/api/nexus/{ws.id}/cancel", headers=_auth(), json={}).status_code == 422
    # 任务不存在 → 404
    assert client.post(f"/api/nexus/{ws.id}/cancel", headers=_auth(),
                       json={"task_id": "nope"}).status_code == 404
    # 未鉴权 → 401
    assert client.post(f"/api/nexus/{ws.id}/cancel", json={"task_id": "x"}).status_code == 401


def test_cancel_ownership_404(client, ws):
    with Session(engine) as s:
        if s.get(models.User, "u-can-intruder") is None:
            s.add(models.User(
                id="u-can-intruder", username="can-intruder",
                password_hash=models.hash_password("pw"),
                api_key_hash=models.hash_api_key("ak-can-intruder"),
                api_key="ak-can-intruder",
            ))
            s.commit()
    tid = _mk_task(ws.id, ws.user_id, status="working")
    r = client.post(f"/api/nexus/{ws.id}/cancel", headers=_auth("ak-can-intruder"),
                    json={"task_id": tid})
    assert r.status_code == 404  # 非属主不泄露存在性
    with Session(engine) as s:
        assert s.get(models.A2aTask, tid).status == "working"  # 未被中断
