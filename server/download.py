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
    text = INSTALL_SH.read_text(encoding="utf-8")
    # 从请求 Host 推断服务地址并注入脚本（有公网域名/反代时用户可设
    # AGENT_SWARM_PUBLIC_URL 覆盖，环境变量或项目根 .env 均可）
    from server.config import get

    server = get("AGENT_SWARM_PUBLIC_URL") or _guess_base(request)
    text = text.replace("__SERVER_URL__", server.rstrip("/"))
    return PlainTextResponse(text, media_type="application/x-sh")


def _guess_base(request: Request) -> str:
    host = request.headers.get("host", "127.0.0.1:8700")
    scheme = request.headers.get("x-forwarded-proto", "http")
    return f"{scheme}://{host}"


routes = [
    Route("/download/plugin.tar.gz", plugin_tarball, methods=["GET"]),
    Route("/download/install.sh", installer, methods=["GET"]),
]
