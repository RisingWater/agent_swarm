from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from server.db import init_db
from server.api import auth, me, workspaces, help_requests
from server.mcp_endpoint import build_mcp_asgi_app, mcp_lifespan


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
    app.include_router(help_requests.router)

    # MCP 端点（自带 apikey 中间件）；规范路径为 /mcp/
    app.mount("/mcp", build_mcp_asgi_app())
    @app.get("/health")
    def health():
        return {"ok": True}

    return app


app = create_app()
