"""把发布包中的管理器部署到当前桌面用户的目录。"""

import filecmp
import os
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import NamedTemporaryFile

from desktop.local import _run_checked, get_autostart, set_autostart


def installed_executable() -> Path:
    name = "AgentSwarmManager.exe" if sys.platform == "win32" else "agent-swarm-manager"
    return Path.home() / "agent-swarm-manager" / name


def install_manager(source: Path, *, tray: bool) -> None:
    windows = sys.platform == "win32"
    if not windows and os.geteuid() == 0:
        raise PermissionError("请从普通用户的应用菜单打开 Agent Swarm Manager。")
    target = installed_executable()
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.is_file() or not filecmp.cmp(source, target, shallow=False):
        with NamedTemporaryFile(dir=target.parent, delete=False) as temp:
            staged = Path(temp.name)
        try:
            shutil.copyfile(source, staged)
            staged.chmod(0o755)
            try:
                staged.replace(target)
            except PermissionError as exc:
                if windows and target.is_file():
                    raise RuntimeError("请先从托盘退出正在运行的 Agent Swarm Manager，再重试安装。") from exc
                raise
        finally:
            staged.unlink(missing_ok=True)

    if windows:
        powershell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
        _run_checked(
            [powershell, "-NoProfile", "-NonInteractive", "-Command",
             "$ErrorActionPreference = 'Stop'; "
             "$shell = New-Object -ComObject WScript.Shell; "
             "$link = $shell.CreateShortcut((Join-Path ($shell.SpecialFolders.Item('Programs')) "
             "'Agent Swarm Manager.lnk')); "
             "$link.TargetPath = $env:SWARM_MANAGER_TARGET; "
             "$link.WorkingDirectory = Split-Path -LiteralPath $env:SWARM_MANAGER_TARGET; "
             "$link.Save()"],
            env={**os.environ, "SWARM_MANAGER_TARGET": str(target)},
        )
    if windows or get_autostart():
        set_autostart(True, executable=target)

    args = [str(target)]
    if tray:
        args.append("--tray")
    environment = {**os.environ, "PYINSTALLER_RESET_ENVIRONMENT": "1"}
    if not windows:
        original = environment.pop("LD_LIBRARY_PATH_ORIG", None)
        if original is None:
            environment.pop("LD_LIBRARY_PATH", None)
        else:
            environment["LD_LIBRARY_PATH"] = original
    subprocess.Popen(args, cwd=target.parent, env=environment)
