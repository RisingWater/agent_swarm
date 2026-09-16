"""飞书命令的工作区查询辅助（与 web /api/workspaces 同语义的在线判定）。"""
from sqlmodel import Session, select

from server import models
from server.db import engine
from server.api.workspaces import ws_is_online

AGENT_TYPE_ICON = {
    "opencode": "🟠",
    "claude": "🟡",
    "claude code": "🟡",
    "deepseek": "🔵",
}


def agent_icon(agent_type: str | None) -> str:
    if not agent_type:
        return "⚪"
    return AGENT_TYPE_ICON.get(agent_type.strip().lower(), "🟣")


def list_workspaces(user_id: str) -> list[dict]:
    """该用户的全部工作区（在线优先 + 名称排序），附在线/类型标注。"""
    with Session(engine) as session:
        rows = session.exec(
            select(models.Workspace).where(models.Workspace.user_id == user_id)
        ).all()
        out = []
        for ws in rows:
            out.append({
                "id": ws.id,
                "name": ws.name,
                "online": ws_is_online(ws),
                "agent_type": ws.agent_type or "",
                "status": ws.status,
            })
    out.sort(key=lambda x: (not x["online"], x["name"]))
    return out


def get_own_workspace(user_id: str, workspace_id: str) -> models.Workspace | None:
    with Session(engine) as session:
        ws = session.get(models.Workspace, workspace_id)
        if ws is None or ws.user_id != user_id:
            return None
        return ws
