"""打包本机平台的桌面插件管理器。"""

import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
import tomllib

from PIL import Image


def build_deb(binary: Path, logo: Path, architecture: str) -> None:
    desktop = Path(__file__).resolve().parent
    deb_architecture = {"x64": "amd64", "arm64": "arm64"}[architecture]
    with (desktop.parent / "pyproject.toml").open("rb") as source:
        version = tomllib.load(source)["project"]["version"]
    if os.environ.get("GITHUB_REF_TYPE") == "tag":
        tag_version = re.search(r"\d+(?:\.\d+)+", os.environ["GITHUB_REF_NAME"])
        if tag_version:
            version = tag_version.group()

    with TemporaryDirectory(prefix="agent-swarm-deb-", dir=desktop / "build") as directory:
        package = Path(directory)
        for source, relative in (
            (binary, "usr/lib/agent-swarm-manager/agent-swarm-manager"),
            (desktop / "deb/application.desktop", "usr/share/applications/agent-swarm-manager.desktop"),
            (desktop / "deb/autostart.desktop", "etc/xdg/autostart/agent-swarm-manager.desktop"),
        ):
            target = package / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            target.chmod(0o755 if source == binary else 0o644)
        icon = package / "usr/share/icons/hicolor/256x256/apps/agent-swarm-manager.png"
        icon.parent.mkdir(parents=True)
        with Image.open(logo) as image:
            image.resize((256, 256), Image.Resampling.LANCZOS).save(icon)
        icon.chmod(0o644)
        package.chmod(0o755)
        subprocess.run(["chmod", "-R", "a+rX", str(package)], check=True)
        control = package / "DEBIAN/control"
        control.parent.mkdir(mode=0o755)
        control.write_text(
            f"Package: agent-swarm-manager\nVersion: {version}\n"
            f"Architecture: {deb_architecture}\n"
            "Section: devel\nPriority: optional\nMaintainer: Agent Swarm contributors\n"
            "Depends: libegl1, libfontconfig1, libgl1, libglib2.0, libxkbcommon-x11-0, "
            "libxcb-cursor0, libxcb-icccm4, libxcb-image0, libxcb-keysyms1, libxcb-render-util0, libxcb-xinerama0\n"
            "Description: Agent Swarm desktop plugin manager\n",
            encoding="utf-8",
        )
        control.chmod(0o644)
        subprocess.run(["dpkg-deb", "--root-owner-group", "--build", str(package), str(binary.with_suffix(".deb"))],
                       check=True)


def main():
    root = Path(__file__).resolve().parent.parent
    directory = root / "desktop"
    architecture = "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "x64"
    system = {"win32": "windows", "darwin": "macos", "linux": "linux"}[sys.platform]
    name = f"AgentSwarmManager-{system}-{architecture}"
    if system == "windows":
        name += "-setup"
    work, dist = directory / "build", directory / "dist"
    work.mkdir(parents=True, exist_ok=True)
    logo = root / "web/public/logo-1024.png"
    platform_icon = []
    if system != "linux":
        icon_path = work / ("swarm.ico" if system == "windows" else "swarm.icns")
        with Image.open(logo) as image:
            if system == "windows":
                image = image.resize((256, 256), Image.Resampling.LANCZOS)
            image.save(icon_path)
        platform_icon = ["--icon", str(icon_path)]
    mode = ["--onedir", "--windowed", "--osx-bundle-identifier", "org.agentswarm.manager"] if system == "macos" else ["--onefile", "--windowed"]
    subprocess.run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--name", name,
                    "--specpath", str(work), "--workpath", str(work), "--distpath", str(dist),
                    "--paths", str(root), "--add-data", f"{logo}:web/public", *platform_icon,
                    *mode, str(directory / "manager.py")], cwd=root, check=True)
    if system == "macos":
        subprocess.run(["ditto", "-c", "-k", "--keepParent", str(dist / (name + ".app")), str(dist / (name + ".zip"))], check=True)
    elif system == "linux":
        build_deb(dist / name, logo, architecture)


if __name__ == "__main__":
    main()
