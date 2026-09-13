from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from server.db import init_db
from server.api import auth, me, workspaces, calls
from server.download import routes as download_routes
from server.mcp_endpoint import build_mcp_asgi_app, mcp_lifespan
from server.nexus import router as nexus_router

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def create_app() -> FastAPI:
    init_db()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async with mcp_lifespan():
            yield

    app = FastAPI(title="agent_swarm", version="0.1.0", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(auth.router)
    app.include_router(me.router)
    app.include_router(workspaces.router)
    app.include_router(calls.router)
    app.include_router(nexus_router)

    # 插件分发（免鉴权）
    for r in download_routes:
        app.router.routes.append(r)

    # MCP 端点（自带 apikey 中间件）；规范路径为 /mcp/
    app.mount("/mcp", build_mcp_asgi_app())

    @app.get("/health")
    def health():
        return {"ok": True}

    # 管理前端（web/dist 构建产物）挂在最后，避免遮挡 /api /mcp /download /health；
    # dist 不存在（未构建）时跳过，服务仍可独立运行
    web_dist = PROJECT_ROOT / "web" / "dist"
    if web_dist.is_dir():
        app.mount("/", StaticFiles(directory=web_dist, html=True), name="web")

    return app


app = create_app()
