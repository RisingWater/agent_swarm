"""下载、安装和账号切换。桌面界面在线程中调用此模块。"""

from dataclasses import dataclass, field
import json
from pathlib import Path
import re
import shutil
import ssl
import tarfile
from tempfile import TemporaryDirectory
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from desktop.local import AGENTS, LocalPlugins, read_json, write_json
from server.plugin_release import archive_manifest

MAX_PACKAGE_BYTES = 100 * 1024 * 1024
HASH = re.compile(r"[a-f0-9]{64}")


class ManagerError(RuntimeError):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def normalize_server(value: str) -> str:
    value = value.strip().rstrip("/")
    if "://" not in value:
        value = "https://" + value
    try:
        url = urlsplit(value)
        if (url.scheme not in ("http", "https") or not url.hostname or url.username is not None
                or url.password is not None or url.path or url.query or url.fragment
                or any(c.isspace() for c in value) or "\\" in value):
            raise ValueError()
        port = url.port
    except ValueError as exc:
        raise ManagerError("请输入有效的服务地址，例如 https://swarm.example.com 或 http://10.0.0.1:8700。") from exc
    host = url.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    if port is not None and port != {"https": 443, "http": 80}[url.scheme]:
        host += f":{port}"
    return f"{url.scheme}://{host}"


def extract_plugins(package: Path, target: Path) -> None:
    """仅解包普通插件文件，拒绝链接、设备、路径穿越和展开超限。"""
    total = 0
    seen = set()
    with tarfile.open(package, "r:gz") as archive:
        for member in archive:
            parts = member.name.removeprefix("./").rstrip("/").split("/")
            if any(p in ("", ".", "..") or re.search(r'[:\\<>|?*"\x00-\x1f]', p) or p.endswith((" ", "."))
                   or p.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
                   for p in parts):
                raise ManagerError("插件包包含无效路径。")
            if parts[0] != "plugins" or len(parts) < 2 or parts[1] not in AGENTS:
                continue
            if member.isdir():
                continue
            total += member.size
            name = "/".join(parts).casefold()
            if not member.isfile() or total > MAX_PACKAGE_BYTES or name in seen or len(seen) >= 5000:
                raise ManagerError("插件包包含链接、重复文件或超出大小限制。")
            seen.add(name)
            dest = target.joinpath(*parts)
            dest.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as src, dest.open("xb") as dst:
                shutil.copyfileobj(src, dst)


@dataclass(frozen=True)
class Account:
    server: str
    name: str
    user_id: str
    api_key: str = field(repr=False)

    def identity(self) -> dict:
        return {"server": self.server, "user": self.user_id, "name": self.name}


class SwarmServer:
    def __init__(self, server: str):
        self.server = normalize_server(server)
        self.http = build_opener(NoRedirect())
        self.cached_package: tuple[str | None, bytes, dict] | None = None

    def request(self, endpoint: str, *, body: dict | None = None, token: str = "", limit=1024 * 1024):
        headers = {"Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        payload = None
        if body is not None:
            payload = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        try:
            with self.http.open(Request(self.server + endpoint, data=payload, headers=headers), timeout=15) as response:
                data = response.read(limit + 1)
                if len(data) > limit:
                    raise ManagerError("服务器返回的数据超出大小限制。")
                return data, response.headers.get("ETag")
        except HTTPError:
            raise
        except (URLError, TimeoutError, ssl.SSLError) as exc:
            raise ManagerError(f"无法连接 {self.server}，请检查地址、网络和证书。") from exc

    def login(self, username: str, password: str) -> Account:
        try:
            login, _ = self.request("/api/auth/login", body={"username": username, "password": password})
            token = json.loads(login)["token"]
            profile, _ = self.request("/api/me", token=token)
            user = json.loads(profile)
            if not user["api_key"]:
                raise ManagerError("该账号没有可用的 API Key。")
            return Account(self.server, user["username"], user["id"], user["api_key"])
        except HTTPError as exc:
            message = "用户名或密码错误。" if exc.code == 401 else f"登录失败（HTTP {exc.code}）。"
            raise ManagerError(message) from exc
        except (ValueError, KeyError, TypeError) as exc:
            raise ManagerError("此地址未返回有效的 Agent Swarm 登录信息。") from exc

    def releases(self) -> dict:
        try:
            data, _ = self.request("/download/plugin-manifest.json")
        except HTTPError as exc:
            if exc.code != 404:
                raise ManagerError(f"无法获取插件版本（HTTP {exc.code}）。") from exc
            # 旧服务端也能安装。HEAD 的 ETag 避免重复下载未变化的旧包。
            try:
                with self.http.open(Request(self.server + "/download/plugin.tar.gz", method="HEAD"), timeout=10) as reply:
                    etag = reply.headers.get("ETag")
            except HTTPError as error:
                if error.code not in (405, 501):
                    raise ManagerError(f"插件包不可用（HTTP {error.code}）。") from error
                etag = None
            if etag and self.cached_package and self.cached_package[0] == etag:
                return self.cached_package[2]
            package, actual_etag = self._download()
            with TemporaryDirectory(prefix="swarm-release-") as temp:
                file = Path(temp) / "package.tar.gz"
                file.write_bytes(package)
                manifest = archive_manifest(file)
            self.cached_package = (actual_etag, package, manifest)
            return manifest
        try:
            manifest = json.loads(data)
            if not HASH.fullmatch(manifest["sha256"]) or not all(
                name in AGENTS and HASH.fullmatch(digest) for name, digest in manifest["plugins"].items()
            ):
                raise ValueError()
            return manifest
        except (ValueError, KeyError, AttributeError, TypeError) as exc:
            raise ManagerError("服务器的插件版本清单格式无效。") from exc

    def _download(self):
        try:
            return self.request("/download/plugin.tar.gz", limit=MAX_PACKAGE_BYTES)
        except HTTPError as exc:
            raise ManagerError(f"下载插件失败（HTTP {exc.code}）。") from exc

    def download(self, manifest: dict, dest: Path) -> None:
        from hashlib import sha256

        if self.cached_package and self.cached_package[2]["sha256"] == manifest["sha256"]:
            data = self.cached_package[1]
        else:
            data, _ = self._download()
        if sha256(data).hexdigest() != manifest["sha256"]:
            raise ManagerError("下载期间服务器插件包发生变化，请重新检查版本。")
        dest.write_bytes(data)


class PluginManager:
    def __init__(self, state_dir: Path, local: LocalPlugins, legacy_state: Path | None = None):
        self.state_path = state_dir / "config.json"
        self.local = local
        self.account: Account | None = None
        self.server: SwarmServer | None = None
        self.releases: dict = {}
        if legacy_state and not self.state_path.exists() and legacy_state.is_file():
            self.state = read_json(legacy_state)
            self._save()
        else:
            self.state = read_json(self.state_path)
        saved = self.state.get("account")
        if isinstance(saved, dict) and all(isinstance(saved.get(key), str) and saved[key]
                                         for key in ("server", "name", "user", "api_key")):
            self.server = SwarmServer(saved["server"])
            self.account = Account(self.server.server, saved["name"], saved["user"], saved["api_key"])

    def _save(self) -> None:
        write_json(self.state_path, self.state)

    def login(self, server: str, username: str, password: str, progress) -> dict:
        remote = SwarmServer(server)
        account = remote.login(username, password)
        installed = [name for name in AGENTS if self.local.installed(name)]
        previous = self.state.get("account")
        changes_account = previous and (previous["server"], previous["user"]) != (account.server, account.user_id)
        pending = self.state.get("reinstall", [])
        reinstall = [name for name in installed if changes_account or name in pending
                     or not self.local.config_matches(name, account.server, account.api_key)]
        state = {**self.state, "account": {**account.identity(), "api_key": account.api_key},
                 "reinstall": reinstall.copy()}
        write_json(self.state_path, state)
        self.state, self.account, self.server = state, account, remote
        self.releases = {}
        if reinstall:
            return self.install(reinstall, progress)
        return {}

    def check(self) -> dict:
        if not self.server and self.state.get("account"):
            self.server = SwarmServer(self.state["account"]["server"])
        if self.server:
            self.releases = self.server.releases()["plugins"]
        return self.snapshot()

    def snapshot(self) -> dict:
        probes = self.local.detect()
        previous = self.state.get("installed", {})
        rows = {}
        for name in AGENTS:
            installed = self.local.installed(name)
            version = previous.get(name, {}).get("version") if installed else None
            latest = self.releases.get(name)
            mismatch = name in self.state.get("reinstall", []) or bool(
                installed and self.account and not self.local.config_matches(name, self.account.server, self.account.api_key)
            )
            rows[name] = {"agent": probes[name], "installed": installed, "version": version,
                          "latest": latest, "needs_update": mismatch or bool(installed and latest and version != latest)}
        return {"account": self.account.identity() if self.account else None, "rows": rows}

    def install(self, names: list[str], progress) -> dict:
        if not self.server or not self.account:
            raise ManagerError("请先登录。")
        manifest = self.server.releases()
        self.releases = manifest["plugins"]
        previous = self.state.setdefault("installed", {})
        results = {}
        with TemporaryDirectory(prefix="swarm-install-") as temp:
            root = Path(temp)
            package = root / "package.tar.gz"
            self.server.download(manifest, package)
            extract_plugins(package, root)
            for name in names:
                progress(f"正在配置 {AGENTS[name].label}…")
                try:
                    revision = self.releases.get(name)
                    if not revision:
                        raise ManagerError("服务器没有分发此插件。")
                    files, activation = self.local.install(name, root / "plugins" / name, self.account)
                    previous[name] = {"version": revision, "files": files}
                    if name in self.state.get("reinstall", []):
                        self.state["reinstall"].remove(name)
                    self._save()
                    results[name] = (True, activation)
                except (RuntimeError, OSError, ValueError) as exc:
                    results[name] = (False, str(exc).replace(self.account.api_key, "••••"))
        return results

    def logout(self, progress) -> dict:
        results = {}
        previous = self.state.setdefault("installed", {})
        for name in AGENTS:
            if not self.local.installed(name) and name not in previous:
                continue
            progress(f"正在卸载 {AGENTS[name].label}…")
            try:
                activation = self.local.uninstall(name, previous.get(name, {}).get("files", {}))
                previous.pop(name, None)
                self._save()
                results[name] = (True, activation)
            except (RuntimeError, OSError, ValueError) as exc:
                secret = self.account.api_key if self.account else ""
                message = str(exc)
                results[name] = (False, message.replace(secret, "••••") if secret else message)
        if all(ok for ok, _ in results.values()):
            state = {key: value for key, value in self.state.items() if key not in ("account", "reinstall")}
            write_json(self.state_path, state)
            self.state = state
            self.account = self.server = None
            self.releases = {}
        return results
