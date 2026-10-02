# -*- coding: utf-8 -*-
"""插件 / 规划器一键安装脚本分发端点（免鉴权）。"""
import pytest
from fastapi.testclient import TestClient

from server.main import app


@pytest.fixture()
def client():
    c = TestClient(app)
    yield c
    c.close()


def test_planner_install_scripts_served(client):
    """planner-install.sh/.ps1 可下载，且 __SERVER_URL__ 已按请求 Host 注入。"""
    r = client.get("/download/planner-install.sh", headers={"host": "swarm.example:8700"})
    assert r.status_code == 200
    assert "__SERVER_URL__" not in r.text
    assert "http://swarm.example:8700" in r.text
    assert "agent_swarm_planner" in r.text          # 克隆目标仓库
    assert "deploy/install.sh" in r.text            # 跑仓库自带安装
    assert "~/.agent_swarm/agent_swarm_planner" in r.text

    r2 = client.get("/download/planner-install.ps1", headers={"host": "swarm.example:8700"})
    assert r2.status_code == 200
    assert "__SERVER_URL__" not in r2.text
    assert "http://swarm.example:8700" in r2.text
    assert "agent_swarm_planner" in r2.text
