"""插件分发端点（免鉴权）：
- GET /download/plugin.tar.gz  插件包（deploy/start.sh 启动时打包到 data/）
- GET /download/install.sh     一键安装脚本（curl ... | bash -s -- --server ... --api-key ...）
"""
from pathlib import Path

from starlette.requests import Request
from starlette.responses import FileResponse, PlainTextResponse
from starlette.routing import Route

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PLUGIN_TGZ = PROJECT_ROOT / "data" / "agent-swarm-plugin.tar.gz"
INSTALL_SH = PROJECT_ROOT / "deploy" / "install.sh"


async def plugin_tarball(request: Request) -> FileResponse:
    if not PLUGIN_TGZ.exists():
        return PlainTextResponse("plugin package not found, restart server to build it", 404)
    return FileResponse(
        PLUGIN_TGZ,
        media_type="application/gzip",
        filename="agent-swarm-plugin.tar.gz",
    )


async def installer(request: Request) -> PlainTextResponse:
    if not INSTALL_SH.exists():
        return PlainTextResponse("install.sh not found", 404)
    return PlainTextResponse(
        INSTALL_SH.read_text(encoding="utf-8"),
        media_type="application/x-sh",
    )


routes = [
    Route("/download/plugin.tar.gz", plugin_tarball, methods=["GET"]),
    Route("/download/install.sh", installer, methods=["GET"]),
]
