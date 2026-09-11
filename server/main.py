from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from server.db import init_db
from server.api import auth, me, teams, workspaces, help_requests


def create_app() -> FastAPI:
    init_db()
    app = FastAPI(title="agent_swarm", version="0.1.0")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(auth.router)
    app.include_router(me.router)
    app.include_router(teams.router)
    app.include_router(workspaces.router)
    app.include_router(help_requests.router)

    @app.get("/health")
    def health():
        return {"ok": True}

    return app


app = create_app()
