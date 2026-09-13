"""插件分发端点（免鉴权）：
- GET /download/plugin.tar.gz  插件包（deploy/start.sh 启动时打包到 data/）
- GET /download/install.sh     一键安装脚本（curl ... | bash -s -- --server ... --api-key ...）
- GET /download/install.ps1    Windows 一键安装脚本（PowerShell 5.1+，同上注入 server 地址）
"""
from pathlib import Path

from starlette.requests import Request
from starlette.responses import FileResponse, PlainTextResponse, Response
from starlette.routing import Route

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PLUGIN_TGZ = PROJECT_ROOT / "data" / "agent-swarm-plugin.tar.gz"
INSTALL_SH = PROJECT_ROOT / "deploy" / "install.sh"
INSTALL_PS1 = PROJECT_ROOT / "deploy" / "install.ps1"


async def plugin_tarball(request: Request) -> FileResponse:
    if not PLUGIN_TGZ.exists():
        return PlainTextResponse("plugin package not found, restart server to build it", 404)
    return FileResponse(
        PLUGIN_TGZ,
        media_type="application/gzip",
        filename="agent-swarm-plugin.tar.gz",
    )


def _server_base(request: Request) -> str:
    """请求 Host 推断服务地址；有公网域名/反代时用 AGENT_SWARM_PUBLIC_URL 覆盖。"""
    from server.config import get

    return get("AGENT_SWARM_PUBLIC_URL") or _guess_base(request)


async def installer(request: Request) -> PlainTextResponse:
    if not INSTALL_SH.exists():
        return PlainTextResponse("install.sh not found", 404)
    text = INSTALL_SH.read_text(encoding="utf-8")
    text = text.replace("__SERVER_URL__", _server_base(request).rstrip("/"))
    return PlainTextResponse(text, media_type="application/x-sh")


async def installer_ps1(request: Request) -> Response:
    """ps1 含中文注释必须 UTF-8。注意不能加 BOM：BOM 会随 irm 文本进入
    scriptblock::Create，PS 5.1 执行时报"无法将﻿#识别为命令"。
    一键命令（irm | iex 场景）不含 BOM；本地直接执行无 BOM 的 ps1 会按 ANSI
    读导致中文乱码破坏语法——因此仓库内的 ps1 源文件一律无 BOM，
    依赖场景规避：分发包中的子脚本（install-*.ps1）由分发器下载 tar 包解压后
    Copy 到本地执行，这些文件在打包前已加 BOM（见 deploy 打包脚本/分发器约定）。
    本分发器自身设计为仅经 irm | iex 执行，无本地执行场景。"""
    if not INSTALL_PS1.exists():
        return PlainTextResponse("install.ps1 not found", 404)
    text = INSTALL_PS1.read_text(encoding="utf-8-sig")  # 容忍源文件意外带 BOM
    text = text.replace("__SERVER_URL__", _server_base(request).rstrip("/"))
    return Response(content=text.encode("utf-8"), media_type="text/plain; charset=utf-8")


def _guess_base(request: Request) -> str:
    host = request.headers.get("host", "127.0.0.1:8700")
    scheme = request.headers.get("x-forwarded-proto", "http")
    return f"{scheme}://{host}"


routes = [
    Route("/download/plugin.tar.gz", plugin_tarball, methods=["GET"]),
    Route("/download/install.sh", installer, methods=["GET"]),
    Route("/download/install.ps1", installer_ps1, methods=["GET"]),
]
