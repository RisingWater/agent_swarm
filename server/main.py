from contextlib import asynccontextmanager
import asyncio
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from server.db import init_db
from server.api import auth, me, workspaces, calls, chat_binds, admin
from server.download import routes as download_routes
from server.mcp_endpoint import build_mcp_asgi_app, mcp_lifespan
from server.nexus_a2a import router as nexus_a2a_router
from server.weixin import gateway as weixin_gateway
from server.api.weixin import router as weixin_router

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _start_feishu():
    """FEISHU_APP_ID/SECRET 已配置时启动飞书网关；否则静默跳过。

    在 lifespan（事件循环内）调用：create_task 后台启动，绝不阻塞/等待——
    曾用 run_coroutine_threadsafe(...).result() 在主线程等自己 → 死锁 TimeoutError，
    整个应用启动失败（2026-09-16）。
    """
    from server.config import get

    app_id = get("FEISHU_APP_ID")
    app_secret = get("FEISHU_APP_SECRET")
    if not app_id or not app_secret:
        return None
    from server.feishu.gateway import FeishuGateway

    gw = FeishuGateway(app_id, app_secret)
    asyncio.create_task(gw.start())
    return gw


def create_app() -> FastAPI:
    init_db()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async with mcp_lifespan():
            feishu = _start_feishu()
            # 微信 ClawBot：恢复已登录用户的收消息循环（登录本身由用户在账号页扫码触发）
            try:
                await weixin_gateway.start_all()
                from server.weixin import bridge as weixin_bridge

                weixin_bridge.bind_listener()
            except Exception:
                import logging

                logging.getLogger("nexus-weixin").exception("weixin start_all failed")
            try:
                yield
            finally:
                if feishu is not None:
                    feishu.stop()
                await weixin_gateway.stop_all()

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
    app.include_router(chat_binds.router)
    app.include_router(admin.router)
    app.include_router(nexus_a2a_router)
    app.include_router(weixin_router)

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
