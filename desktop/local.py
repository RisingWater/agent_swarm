"""CLI 探测、各适配器安装与卸载，以及本机生效状态。"""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from tempfile import NamedTemporaryFile
from urllib.parse import unquote

import psutil


@dataclass(frozen=True)
class Agent:
    label: str
    command: str
    commands: tuple[str, ...] = ()


AGENTS = {
    "opencode": Agent("OpenCode", "opencode", ("add", "add-planner")),
    "claude": Agent("Claude Code", "claude", ("add", "add-planner", "register", "enable", "disable", "remove")),
    "deepseek": Agent("DeepSeek Harness", "dsh"),
    "codex": Agent("Codex", "codex"),
}
VERSION = re.compile(r"(?<!\d)\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?")
JSONC_TOKEN = re.compile(r'"(?:\\.|[^"\\])*"|//[^\r\n]*|/\*[\s\S]*?\*/|,(?=\s*[}\]])')
DSH_ENTRY = re.compile(
    r"(?m)^# agent-swarm MCP \(by install-deepseek[^\n]*\)\r?\n"
    r"- insert:\r?\n[ \t]+- id: agent-swarm-mcp[^\n]*\n(?:^[ \t]+[^\n]*\n?)*"
)
DSH_ENV = re.compile(r"(?m)^[ \t]*AGENT_SWARM_(?:SERVER|API_KEY)=[^\r\n]*\r?\n?")
WINDOWS = os.name == "nt"
LAUNCH_NAME = "AgentSwarmManager"


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return {}
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} 不是 JSON 对象")
    return value


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(mode="w", encoding="utf-8", newline="", dir=path.parent, delete=False) as tmp:
        name = Path(tmp.name)
        try:
            tmp.write(text)
            tmp.close()
            name.replace(path)
        finally:
            name.unlink(missing_ok=True)


def write_json(path: Path, value: dict) -> None:
    write_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig") if path.is_file() else ""


def run(command, env=None, timeout=30, cwd=None):
    args = [str(arg) for arg in command]
    if getattr(sys, "frozen", False):
        env = dict(os.environ if env is None else env)
        original = env.pop("LD_LIBRARY_PATH_ORIG", None)
        if original is not None:
            env["LD_LIBRARY_PATH"] = original
        else:
            env.pop("LD_LIBRARY_PATH", None)
    options = dict(capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, cwd=cwd)
    if WINDOWS:
        options["creationflags"] = subprocess.CREATE_NO_WINDOW
        if Path(args[0]).suffix.lower() in {".cmd", ".bat", ".ps1"}:
            env = {**(env or os.environ), "SWARM_GUI_CLI_ARGS": json.dumps(args)}
            args = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
                    "$ErrorActionPreference = 'Stop'; "
                    "$v = ConvertFrom-Json $env:SWARM_GUI_CLI_ARGS; $p = $v[0]; "
                    "$a = @($v | Select-Object -Skip 1); & $p @a; exit $LASTEXITCODE"]
    try:
        return subprocess.run(args, env=env, **options)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("客户端命令运行超时。") from exc


def _run_checked(args, *, env=None, timeout=30, cwd=None, secret=""):
    result = run(args, env=env, timeout=timeout, cwd=cwd)
    if result.returncode:
        # 输出只用于当前窗口，避免安装脚本打印的凭据进入错误详情。
        output = (result.stderr + "\n" + result.stdout).strip()
        if secret:
            output = output.replace(secret, "••••")
        if "Bearer " in output:
            output = re.sub(r"Bearer [^\s\"']+", "Bearer ••••", output)
        raise RuntimeError(output[-1800:] or f"客户端命令失败（{result.returncode}）。")
    return result.stdout


def _read_jsonc(path: Path) -> dict:
    text = read_text(path)
    if not text.strip():
        return {}
    text = JSONC_TOKEN.sub(lambda match: match[0] if match[0].startswith('"') else "", text)
    text = JSONC_TOKEN.sub(lambda match: match[0] if match[0].startswith('"') else "", text)
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} 不是配置对象。")
    return value


def _fingerprint(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def _managed_ref(value, root: Path) -> bool:
    if isinstance(value, dict):
        value = value.get("package")
    if not isinstance(value, str):
        return False
    path = unquote(value.removeprefix("file://"))
    if WINDOWS and re.match(r"^/[A-Za-z]:", path):
        path = path[1:]
    candidate = Path(path)
    return candidate.is_absolute() and candidate.resolve().is_relative_to(root.resolve())


class LocalPlugins:
    def __init__(self, home=None):
        self.home = home or Path.home()
        self.config = self.home / ".config"
        self.codex_home = Path(os.environ.get("CODEX_HOME", self.home / ".codex")) if home is None else home / ".codex"
        self.claude_home = self.home / ".claude"
        self.dsh_home = self.home / ".dsh"
        self.roots = {
            "opencode": self.config / "opencode/plugins/agent-swarm",
            "claude": self.claude_home / "agent-swarm",
            "deepseek": self.dsh_home / "agent-swarm-plugin",
            "codex": self.codex_home / "agent-swarm/codex",
        }
        self.settings = {
            "opencode": self.config / "opencode/agent-swarm.json",
            "claude": self.roots["claude"] / "config.json",
            "deepseek": self.config / "dsh/agent-swarm.json",
            "codex": self.roots["codex"] / "swarm.json",
        }

    def executable(self, name: str) -> Path | None:
        command = AGENTS[name].command
        fallback = [self.home / ".local/bin" / command, self.home / "bin" / command]
        if WINDOWS:
            local = Path(os.environ.get("LOCALAPPDATA", self.home / "AppData/Local"))
            roaming = Path(os.environ.get("APPDATA", self.home / "AppData/Roaming"))
            fallback += [roaming / "npm" / (command + ".cmd"), self.home / ".local/bin" / (command + ".exe")]
            if name == "opencode":
                fallback += sorted((roaming / "ai.opencode.desktop/cli").glob("*/opencode-cli.exe"), reverse=True)
            if name == "deepseek":
                fallback.append(local / "Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd")
        else:
            fallback += [Path("/opt/homebrew/bin") / command, Path("/usr/local/bin") / command]
            if name == "deepseek":
                fallback += [
                    self.home / ".local/share/DeepSeek Harness/resources/runtime/cli/bin/dsh",
                    Path("/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"),
                ]
        if found := shutil.which(command):
            return Path(found)
        if not WINDOWS:
            # GUI 进程（桌面自启/双击启动）不经过用户 shell，PATH 里没有 nvm/bun/asdf
            # 等工具注入的目录——以用户登录 shell 的视角再找一次。interactive(-i) 才会
            # 加载 .zshrc/.bashrc（nvm 就在这里注入）；超时/无 shell 则退回静态 fallback。
            shell = os.environ.get("SHELL") or "/bin/bash"
            if Path(shell).is_file():
                try:
                    result = run([shell, "-i", "-l", "-c", f"which {command}"], timeout=10)
                    candidate = Path(result.stdout.strip())
                    if result.returncode == 0 and candidate.is_file():
                        return candidate
                except (OSError, RuntimeError):
                    pass
        return next((path for path in fallback if path.is_file()), None)

    def detect(self) -> dict:
        def probe(name):
            path = self.executable(name)
            version = ""
            if path:
                try:
                    result = run([path, "--version"], timeout=12)
                    match = VERSION.search(result.stdout + "\n" + result.stderr)
                    version = match[0] if match and result.returncode == 0 else ""
                except (OSError, RuntimeError):
                    pass
            return {"path": str(path) if path else "", "version": version}
        with ThreadPoolExecutor(max_workers=len(AGENTS)) as pool:
            return dict(zip(AGENTS, pool.map(probe, AGENTS)))

    def installed(self, name: str) -> bool:
        marker = {"opencode": "src/index.ts", "claude": "keepalive.mjs", "deepseek": "cordis.patch.yml",
                  "codex": "install.mjs"}[name]
        return self.settings[name].is_file() or (self.roots[name] / marker).is_file()

    def config_matches(self, name, server, key) -> bool:
        try:
            saved = read_json(self.settings[name])
        except (ValueError, OSError):
            return False
        address = saved.get("server") or saved.get("serverUrl")
        return isinstance(address, str) and address.rstrip("/") == server and saved.get("apiKey") == key

    def _path_env(self, executable: Path) -> dict:
        return {**os.environ, "PATH": os.pathsep.join([str(executable.parent), os.environ.get("PATH", "")])}

    def _files(self, name: str) -> list[Path]:
        root = self.config / "opencode" if name == "opencode" else self.claude_home
        files = [root / "commands" / f"swarm-{command}.md" for command in AGENTS[name].commands]
        if name == "deepseek":
            files.append(self.dsh_home / "skills/agent-swarm/SKILL.md")
        return files

    def install(self, name: str, source: Path, account) -> tuple[dict, str]:
        executable = self.executable(name)
        if not executable:
            raise RuntimeError(f"未检测到 {AGENTS[name].label}。")
        env = {**self._path_env(executable), "AGENT_SWARM_SERVER": account.server,
               "AGENT_SWARM_API_KEY": account.api_key}
        if name == "codex":
            self.codex_home.mkdir(parents=True, exist_ok=True)
        profiles = [None]
        if name == "deepseek":
            profiles = self._installed_dsh_profiles()
            if not profiles:
                profiles = [os.environ.get("DSH_PROFILE") or (
                    "desktop" if any(part.lower() == "deepseek harness" for part in executable.parts) else "web"
                )]
        suffix = "ps1" if WINDOWS else "sh"
        script = source / f"install-{name}.{suffix}"
        if not script.is_file():
            raise RuntimeError("服务器包中缺少适用于当前平台的安装脚本。")
        if WINDOWS:
            script.write_text(read_text(script), encoding="utf-8-sig")
            env["SWARM_GUI_INSTALLER"] = str(script)
            args = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
                    "$ErrorActionPreference = 'Stop'; "
                    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); "
                    "& $env:SWARM_GUI_INSTALLER -Server $env:AGENT_SWARM_SERVER -ApiKey $env:AGENT_SWARM_API_KEY"
                    + (" -Global" if name == "opencode" else " -Profile $env:SWARM_GUI_PROFILE" if name == "deepseek" else "")]
        else:
            shell = 'exec bash "$1" --server "$AGENT_SWARM_SERVER" --api-key "$AGENT_SWARM_API_KEY"'
            if name == "deepseek":
                shell += ' --profile "$SWARM_GUI_PROFILE"'
            args = ["bash", "-c", shell,
                    "swarm-install", script]
        old_dsh = read_json(self.settings[name]) if name == "deepseek" else {}
        dsh_env = self.dsh_home / ".env"
        old_dsh_env = read_text(dsh_env) if name == "deepseek" else ""
        for profile in profiles:
            if profile is not None:
                if not re.fullmatch(r"[a-zA-Z0-9_-]+", profile):
                    raise RuntimeError("dsh profile 名称无效。")
                env["SWARM_GUI_PROFILE"] = profile
            _run_checked(args, env=env, timeout=240, cwd=source, secret=account.api_key)
        if name == "deepseek":
            # 旧版脚本跳过已存在的 MCP 项，换账号时同步所有由 Swarm 写入的层。
            for patch in self._dsh_patches():
                content = read_text(patch)
                if DSH_ENTRY.search(content):
                    def replace(match):
                        entry = re.sub(r"(?m)^(\s*url: ).*$", lambda m: m[1] + account.server + "/mcp/", match[0])
                        return re.sub(r"(?m)^(\s*Authorization: ).*$", lambda m: m[1] + "Bearer " + account.api_key, entry)
                    write_text(patch, DSH_ENTRY.sub(replace, content))
            write_text(dsh_env, DSH_ENV.sub("", old_dsh_env).rstrip() + "\n"
                       + f"AGENT_SWARM_SERVER={account.server}\nAGENT_SWARM_API_KEY={account.api_key}\n")
            if old_dsh.get("executionMode") in ("foreground", "background"):
                write_json(self.settings[name], {**read_json(self.settings[name]), "executionMode": old_dsh["executionMode"]})
        if not self.config_matches(name, account.server, account.api_key):
            raise RuntimeError("安装程序退出，但未检测到新账号的插件配置。")
        files = {str(path): _fingerprint(path) for path in self._files(name) if path.is_file()}
        return files, self.activate(name)

    def _dsh_patches(self):
        return (self.dsh_home / "profiles").glob("*/cordis.patch.yml")

    def _installed_dsh_profiles(self) -> list[str]:
        return [
            package.parent.name for package in (self.dsh_home / "profiles").glob("*/package.json")
            if "dsh-agent-swarm-plugin" in read_json(package).get("dependencies", {})
        ]

    def _uninstall_opencode(self, old: dict) -> None:
        root = self.config / "opencode"
        for name in ("opencode.json", "opencode.jsonc", "tui.json", "tui.jsonc"):
            path = root / name
            config = _read_jsonc(path)
            changed = False
            for key in ("plugin", "plugins"):
                if isinstance(config.get(key), list):
                    filtered = [value for value in config[key] if not _managed_ref(value, self.roots["opencode"])]
                    if filtered != config[key]:
                        config[key], changed = filtered, True
            mcp = config.get("mcp", {})
            if isinstance(mcp, dict):
                for entries in (mcp, mcp.get("servers", {})):
                    if isinstance(entries, dict):
                        changed = self._remove_owned_remote(entries, old) or changed
            if changed:
                write_json(path, config)

    @staticmethod
    def _remove_owned_remote(entries, old) -> bool:
        remote = entries.get("agent-swarm")
        address = old.get("serverUrl") or old.get("server")
        if address and isinstance(remote, dict) and str(remote.get("url", "")).rstrip("/") == address.rstrip("/") + "/mcp":
            del entries["agent-swarm"]
            return True
        return False

    def _uninstall_claude(self, old: dict) -> None:
        config = self.home / ".claude.json"
        data = read_json(config)
        entries = data.get("mcpServers", {})
        if not isinstance(entries, dict):
            return
        changed = self._remove_owned_remote(entries, old)
        keepalive = entries.get("agent-swarm-keepalive", {})
        args = keepalive.get("args", []) if isinstance(keepalive, dict) else []
        if len(args) == 1 and _managed_ref(args[0], self.roots["claude"]):
            del entries["agent-swarm-keepalive"]
            changed = True
        if changed:
            write_json(config, data)

    def _uninstall_dsh(self) -> None:
        executable = self.executable("deepseek")
        for profile in self._installed_dsh_profiles():
            if not executable:
                raise RuntimeError("需要 dsh CLI 移除已登记的插件包。")
            _run_checked([executable, "plugin", "--profile", profile, "remove", "dsh-agent-swarm-plugin"],
                         env=self._path_env(executable), timeout=120)
        for patch in self._dsh_patches():
            content = read_text(patch)
            if DSH_ENTRY.search(content):
                write_text(patch, DSH_ENTRY.sub("", content))
        dsh_env = self.dsh_home / ".env"
        if dsh_env.is_file():
            write_text(dsh_env, DSH_ENV.sub("", read_text(dsh_env)))

    def uninstall(self, name: str, files: dict) -> str:
        root = self.roots[name]
        if name == "codex":
            if (root / "install.mjs").is_file():
                _run_checked(["node", root / "install.mjs", "--uninstall"], cwd=self.home)
            elif self.settings[name].exists():
                raise RuntimeError("Codex 卸载器缺失，请先更新插件再卸载。")
        else:
            old = read_json(self.settings[name])
            if name == "opencode":
                self._uninstall_opencode(old or read_json(root / "config.json"))
            elif name == "claude":
                self._uninstall_claude(old)
            elif name == "deepseek":
                self._uninstall_dsh()
            for path in self._files(name):
                if path.is_file():
                    digest = files.get(str(path))
                    known_legacy = not digest and re.search(r"agent[_-]swarm|workspace_add", read_text(path), re.I)
                    if known_legacy or digest == _fingerprint(path):
                        path.unlink()
            # 这是安装器创建的专用目录。对用户自建链接仅移除入口，不遍历目标。
            if root.is_symlink() or (WINDOWS and os.path.isjunction(root)):
                raise RuntimeError(f"插件目录是链接，请检查 {root}。")
            if root.is_dir():
                shutil.rmtree(root)
            self.settings[name].unlink(missing_ok=True)
        return self.activate(name, removing=True)

    def activate(self, name: str, removing=False) -> str:
        running = self._client_processes(name)
        if not running:
            return "下次启动客户端时生效"
        if name == "opencode" and not removing:
            entry = self.roots[name] / "index.ts"
            path = self.executable(name)
            try:
                if entry.is_file() and path and re.search(r"\b[2-9]\d*\.", run([path, "--version"], timeout=5).stdout):
                    entry.touch()
                    return "已请求 OpenCode 服务热重载"
            except (OSError, RuntimeError):
                pass
        if name == "codex" and not removing and self._reload_codex():
            return "已请求 Codex 共享服务重新加载 MCP"
        return "客户端仍在运行，重开会话后生效"

    def _reload_codex(self) -> bool:
        proxy = self.roots["codex"] / "proxy.mjs"
        if not proxy.is_file():
            return False
        try:
            result = run(["node", "--input-type=module", "-e",
                          'const {openProxy}=await import(process.argv[1]); const app=await openProxy(process.cwd()); '
                          'try { await app.call("config/mcpServer/reload", {}); } finally { await app.close(); }',
                          proxy.as_uri()], timeout=10, cwd=self.home)
            return result.returncode == 0
        except (OSError, RuntimeError):
            return False

    @staticmethod
    def _client_processes(name: str) -> list:
        match = {"opencode": r"opencode(?:-cli|[ -]desktop)?", "deepseek": r"dsh|deepseek[ -]harness",
                 "codex": r"codex|chatgpt", "claude": r"claude(?:-code)?"}[name]
        processes = []
        for process in psutil.process_iter(["name", "cmdline"], ad_value=None):
            image = process.info["name"] or ""
            if re.fullmatch(r"(?:" + match + r")(?:\.exe)?", image, re.I):
                processes.append(process)
            elif name == "deepseek" and image.lower() in ("node", "node.exe", "bun", "bun.exe"):
                args = process.info["cmdline"] or []
                if any(re.search(r"[/\\](?:dsh|deepseek-harness)(?:[/\\]|\.)", arg, re.I) for arg in args[1:]) and "web" in args:
                    processes.append(process)
        return processes

    def restart_desktop(self, name: str) -> str:
        """只请求已识别的本用户桌面窗口正常关闭，退出成功后再启动。"""
        if not WINDOWS:
            return "当前客户端需要重开会话"
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        user32.IsWindowVisible.argtypes = [wintypes.HWND]
        user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        windows = {}

        @callback_type
        def visit(hwnd, _):
            if user32.IsWindowVisible(hwnd):
                pid = wintypes.DWORD()
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                windows.setdefault(pid.value, []).append(hwnd)
            return True

        user32.EnumWindows(visit, 0)
        desktop_names = {
            "opencode": {"opencode.exe", "opencode desktop.exe", "opencode-desktop.exe"},
            "claude": {"claude.exe"},
            "codex": {"codex.exe", "chatgpt.exe"},
            "deepseek": {"deepseek harness.exe", "deepseek-harness.exe"},
        }[name]
        owner = psutil.Process().username()
        candidates = []
        for process in self._client_processes(name):
            try:
                if process.pid not in windows or process.username() != owner:
                    continue
                exe = Path(process.exe())
                # Console 程序可能由独立的终端进程绘制。仅处理带可见顶层窗口的桌面入口。
                if exe.name.lower() not in desktop_names or not exe.is_file():
                    continue
                args = process.cmdline()[1:]
                if any(arg.startswith("--type=") for arg in args):
                    continue
                cwd = process.cwd() or str(self.home)
                candidates.append((process, exe, args, cwd))
            except (psutil.Error, OSError):
                continue
        if not candidates:
            return "没有可正常关闭的桌面窗口，请重开对应终端会话"
        restarted = 0
        for process, exe, args, cwd in candidates:
            for hwnd in windows[process.pid]:
                user32.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE
            try:
                process.wait(timeout=8)
            except psutil.TimeoutExpired:
                continue
            subprocess.Popen([str(exe), *args], cwd=cwd, close_fds=True)
            restarted += 1
        return "桌面客户端已重启" if restarted == len(candidates) else "有窗口仍在运行，等待客户端正常退出后生效"


def _autostart_path() -> Path:
    user_config = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    return user_config / "autostart/agent-swarm-manager.desktop"


def _has_system_autostart() -> bool:
    directories = os.environ.get("XDG_CONFIG_DIRS") or "/etc/xdg"
    return any((Path(directory) / "autostart" / _autostart_path().name).is_file()
               for directory in directories.split(os.pathsep) if directory)


def get_autostart() -> bool:
    if WINDOWS:
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run") as key:
                return bool(winreg.QueryValueEx(key, LAUNCH_NAME)[0])
        except FileNotFoundError:
            return False
    if sys.platform.startswith("linux"):
        entry = _autostart_path()
        if entry.is_file():
            return "Hidden=true" not in read_text(entry).splitlines()
        return _has_system_autostart()
    return False


def set_autostart(enabled: bool, *, executable: Path | None = None) -> None:
    command = [str(executable or sys.executable)]
    if executable is None and not getattr(sys, "frozen", False):
        command += [str(Path(__file__).with_name("manager.py").resolve())]
    command.append("--tray")
    if WINDOWS:
        import winreg
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run",
                                0, winreg.KEY_SET_VALUE) as key:
            if enabled:
                winreg.SetValueEx(key, LAUNCH_NAME, 0, winreg.REG_SZ, subprocess.list2cmdline(command))
            else:
                try:
                    winreg.DeleteValue(key, LAUNCH_NAME)
                except FileNotFoundError:
                    pass
    elif sys.platform.startswith("linux"):
        path = _autostart_path()
        system_entry = _has_system_autostart()
        if enabled and system_entry:
            path.unlink(missing_ok=True)
        elif enabled:
            def quote(arg):
                return '"' + re.sub(r'(["`$\\])', r'\\\1', arg).replace("\\", "\\\\").replace("%", "%%") + '"'
            write_text(path, "[Desktop Entry]\nType=Application\nName=Agent Swarm Manager\n"
                       + "Exec=" + " ".join(map(quote, command)) + "\nTerminal=false\n")
        elif system_entry:
            write_text(path, "[Desktop Entry]\nType=Application\nName=Agent Swarm Manager\nHidden=true\n")
        else:
            path.unlink(missing_ok=True)
