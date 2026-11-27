# -*- coding: utf-8 -*-
"""插件 / 规划器一键安装脚本分发端点（免鉴权）。"""
from hashlib import sha256
from io import BytesIO
import tarfile

import pytest
from fastapi.testclient import TestClient

from server import download
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


def test_manager_manifest_matches_downloaded_package(client, tmp_path, monkeypatch):
    package = tmp_path / "agent-swarm-plugin.tar.gz"
    with tarfile.open(package, "w:gz") as archive:
        content = b"plugin entry"
        member = tarfile.TarInfo("plugins/codex/worker.mjs")
        member.size = len(content)
        archive.addfile(member, BytesIO(content))
    monkeypatch.setattr(download, "PLUGIN_TGZ_CANDIDATES", [package])
    response = client.get("/download/plugin-manifest.json")
    assert response.status_code == 200
    assert len(response.json()["plugins"]["codex"]) == 64
    assert response.json()["sha256"] == sha256(client.get("/download/plugin.tar.gz").content).hexdigest()


@pytest.mark.parametrize(("platform", "name", "media_type"), [
    ("windows", "AgentSwarmManager-windows-x64-setup.exe", "application/octet-stream"),
    ("linux", "AgentSwarmManager-linux-x64.deb", "application/vnd.debian.binary-package"),
    ("macos", "AgentSwarmManager-macos-arm64.zip", "application/octet-stream"),
])
def test_manager_serves_local_build(client, tmp_path, monkeypatch, platform, name, media_type):
    assets = tmp_path / "data"
    assets.mkdir()
    monkeypatch.setattr(download, "PROJECT_ROOT", tmp_path)
    path = f"/download/plugin-manager/{platform}"
    redirect = client.get(path, follow_redirects=False)
    assert redirect.status_code == 307 and redirect.headers["location"].endswith("/" + name)
    (assets / name).write_bytes(b"fixture")
    response = client.get(path)
    assert response.status_code == 200 and response.content == b"fixture"
    assert response.headers["content-type"] == media_type
    assert name in response.headers["content-disposition"]
    assert client.get("/download/plugin-manager/unknown").status_code == 404
