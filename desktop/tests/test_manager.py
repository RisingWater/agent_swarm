from contextlib import contextmanager
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
import os
import tarfile
import threading

import pytest

from desktop.core import ManagerError, PluginManager, extract_plugins
from desktop.local import AGENTS, LocalPlugins, set_autostart, write_json
from server.plugin_release import archive_manifest


def bundle(path, files):
    with tarfile.open(path, "w:gz") as archive:
        for name, content in files.items():
            item = tarfile.TarInfo(name)
            item.size = len(content)
            archive.addfile(item, BytesIO(content))


@contextmanager
def server(package):
    class Handler(BaseHTTPRequestHandler):
        def send_data(self, value):
            response = value if isinstance(value, bytes) else json.dumps(value).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            assert self.path == "/api/auth/login" and body["password"] == "fixture-password"
            self.send_data({"token": body["username"]})

        def do_GET(self):
            if self.path == "/api/me":
                name = self.headers["Authorization"].removeprefix("Bearer ")
                self.send_data({"id": name, "username": name, "api_key": "secret-" + name})
            elif self.path == "/download/plugin-manifest.json":
                self.send_data(archive_manifest(package))
            elif self.path == "/download/plugin.tar.gz":
                self.send_data(package.read_bytes())
            else:
                self.send_error(404)

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as httpd:
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{httpd.server_port}"
        finally:
            httpd.shutdown()
            thread.join()


def test_login_switch_retry_and_offline_logout(tmp_path):
    package = tmp_path / "plugins.tar.gz"
    bundle(package, {f"plugins/{name}/fixture": name.encode() for name in AGENTS})

    class Local:
        configured = {}
        fail_next = False

        def installed(self, name):
            return name in self.configured

        def config_matches(self, name, address, key):
            return self.configured.get(name) == (address, key)

        def install(self, name, source, account):
            assert (source / "fixture").read_text() == name
            self.configured[name] = (account.server, account.api_key)
            if self.fail_next and name == "claude":
                self.fail_next = False
                raise RuntimeError("fixture failure after writing")
            return {}, "installed"

        def uninstall(self, name, files):
            self.configured.pop(name, None)
            return "removed"

        def detect(self):
            return {name: {"path": name, "version": "1.2.3"} for name in AGENTS}

    local = Local()
    manager = PluginManager(tmp_path, local)
    progress = lambda message: None
    with server(package) as first, server(package) as second:
        assert not manager.login(first, "alice", "fixture-password", progress)
        assert all(result[0] for result in manager.install(list(AGENTS), progress).values())
        assert not any(row["needs_update"] for row in manager.snapshot()["rows"].values())
        bundle(package, {f"plugins/{name}/fixture": name.encode() for name in AGENTS} | {"plugins/codex/new": b"v2"})
        assert [name for name, row in manager.check()["rows"].items() if row["needs_update"]] == ["codex"]
        local.fail_next = True
        results = manager.login(second, "bob", "fixture-password", progress)
        assert set(results) == set(AGENTS) and not results["claude"][0]
        assert manager.snapshot()["rows"]["claude"]["needs_update"]
        assert manager.login(second, "bob", "fixture-password", progress) == {"claude": (True, "installed")}
        assert set(local.configured.values()) == {(second, "secret-bob")}
        saved = json.loads(manager.state_path.read_text())
        assert saved["account"]["api_key"] == "secret-bob"
        assert "fixture-password" not in manager.state_path.read_text()
        if os.name != "nt":
            assert manager.state_path.stat().st_mode & 0o077 == 0
        manager = PluginManager(tmp_path, local)
        assert manager.account.name == "bob"
        assert manager.snapshot()["account"] == {"server": second, "user": "bob", "name": "bob"}
        assert manager.install(["codex"], progress)["codex"][0]
    assert all(result[0] for result in manager.logout(progress).values())
    assert not local.configured and manager.account is None
    assert PluginManager(tmp_path, local).account is None
    assert "secret-bob" not in manager.state_path.read_text()


def test_migrates_previous_plugin_records(tmp_path):
    old = tmp_path / "plugins.json"
    new = tmp_path / ".config/agent-swarm-manager"
    write_json(old, {"installed": {"codex": {"version": "old"}}, "account": {
        "name": "previous", "server": "https://fixture.invalid", "user": "account-id",
    }})
    configured = PluginManager(new, LocalPlugins(tmp_path), old)
    assert configured.account is None
    assert configured.state_path == new / "config.json"
    assert configured.state["installed"]["codex"]["version"] == "old"


def test_archive_paths_checked(tmp_path):
    path = tmp_path / "bundle.tar.gz"
    bundle(path, {"plugins/codex/../../outside": b"unsafe"})
    with pytest.raises(ManagerError, match="无效路径"):
        extract_plugins(path, tmp_path / "target")
    assert not (tmp_path / "outside").exists()


def test_manifest_keeps_unrelated_plugin_version(tmp_path):
    path = tmp_path / "bundle.tar.gz"
    files = {"plugins/codex/worker.mjs": b"code", "plugins/claude/nexus_a2a.mjs": b"shared",
             "plugins/opencode/index.ts": b"entry"}
    bundle(path, files)
    before = archive_manifest(path)
    assert before["sha256"] == sha256(path.read_bytes()).hexdigest()
    bundle(path, files | {"plugins/claude/nexus_a2a.mjs": b"new"})
    after = archive_manifest(path)
    assert after["plugins"]["codex"] != before["plugins"]["codex"]
    assert after["plugins"]["opencode"] == before["plugins"]["opencode"]


def test_opencode_and_claude_logout_preserve_unrelated_entries(tmp_path, monkeypatch):
    local = LocalPlugins(tmp_path)
    monkeypatch.setattr(local, "activate", lambda *args, **kwargs: "removed")
    credentials = {"serverUrl": "https://fixture.invalid", "apiKey": "key"}
    remote = {"type": "http", "url": "https://fixture.invalid/mcp/"}
    for name in ("opencode", "claude"):
        write_json(local.settings[name], credentials)
    open_path = tmp_path / ".config/opencode/opencode.jsonc"
    write_json(open_path, {"mcp": {"servers": {"agent-swarm": remote, "keep": {"url": "https://keep.invalid"}}},
                           "plugin": [(local.roots["opencode"] / "src/index.ts").as_uri(), "other-plugin"]})
    claude_path = tmp_path / ".claude.json"
    write_json(claude_path, {"mcpServers": {"agent-swarm": remote, "keep": {"type": "stdio"},
                                         "agent-swarm-keepalive": {"args": [str(local.roots["claude"] / "keepalive.mjs")]}}})
    local.uninstall("opencode", {})
    local.uninstall("claude", {})
    assert json.loads(open_path.read_text())["plugin"] == ["other-plugin"]
    assert set(json.loads(open_path.read_text())["mcp"]["servers"]) == {"keep"}
    assert set(json.loads(claude_path.read_text())["mcpServers"]) == {"keep"}


def test_xdg_autostart(tmp_path, monkeypatch):
    import desktop.local as local

    monkeypatch.setattr(local, "WINDOWS", False)
    monkeypatch.setattr(local.sys, "platform", "linux")
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    monkeypatch.setenv("XDG_CONFIG_DIRS", str(tmp_path / "system"))
    set_autostart(True)
    entry = tmp_path / "autostart/agent-swarm-manager.desktop"
    assert "Exec=" in entry.read_text() and "--tray" in entry.read_text()
    set_autostart(False)
    assert not entry.exists()


def test_deb_user_setup_and_startup_preference(tmp_path, monkeypatch):
    import desktop.local as local
    import desktop.setup as setup

    monkeypatch.setattr(local, "WINDOWS", False)
    monkeypatch.setattr(local.sys, "platform", "linux")
    monkeypatch.setattr(setup.os, "geteuid", lambda: 1000, raising=False)
    home = tmp_path / "user home"
    monkeypatch.setattr(setup.Path, "home", lambda: home)
    config_home = home / ".config"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(config_home))
    system_config = tmp_path / "etc/xdg"
    monkeypatch.setenv("XDG_CONFIG_DIRS", str(system_config))
    system_entry = system_config / "autostart/agent-swarm-manager.desktop"
    system_entry.parent.mkdir(parents=True)
    system_entry.write_text("[Desktop Entry]\nType=Application\n", encoding="utf-8")
    command = []
    monkeypatch.setattr(setup.subprocess, "Popen", lambda args, **kwargs: command.extend(args))
    payload = tmp_path / "package-manager"
    payload.write_bytes(b"first")

    setup.install_manager(payload, tray=True)
    installed = home / "agent-swarm-manager/agent-swarm-manager"
    assert installed.read_bytes() == b"first"
    assert command == [str(installed), "--tray"]
    assert local.get_autostart()
    local.set_autostart(False)
    assert not local.get_autostart()

    command.clear()
    payload.write_bytes(b"updated")
    setup.install_manager(payload, tray=False)
    assert installed.read_bytes() == b"updated"
    assert command == [str(installed)]
    assert not local.get_autostart()
    local.set_autostart(True)
    assert local.get_autostart()
    assert not (config_home / "autostart/agent-swarm-manager.desktop").exists()


def test_windows_setup_targets_installed_executable(tmp_path, monkeypatch):
    import desktop.setup as setup

    monkeypatch.setattr(setup.sys, "platform", "win32")
    monkeypatch.setattr(setup.Path, "home", lambda: tmp_path)
    monkeypatch.setenv("SystemRoot", str(tmp_path))
    calls = []
    monkeypatch.setattr(setup, "_run_checked", lambda args, env: calls.append(("shortcut", env["SWARM_MANAGER_TARGET"])))
    monkeypatch.setattr(setup, "set_autostart", lambda enabled, executable: calls.append(("startup", enabled, executable)))
    monkeypatch.setattr(setup.subprocess, "Popen", lambda args, **kwargs: calls.append(("launch", args)))
    downloaded = tmp_path / "AgentSwarmManager-windows-x64-setup (1).exe"
    downloaded.write_bytes(b"manager")

    setup.install_manager(downloaded, tray=False)
    installed = tmp_path / "agent-swarm-manager/AgentSwarmManager.exe"
    assert installed.read_bytes() == b"manager"
    assert calls == [("shortcut", str(installed)), ("startup", True, installed), ("launch", [str(installed)])]
