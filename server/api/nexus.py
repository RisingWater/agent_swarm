"""nexus 辅助 API：claude hook 脚本上报 timeline 事件（apikey 鉴权）。

claude 的 hooks（PreToolUse/PostToolUse/Stop 等）是独立短命进程，不方便走
WebSocket，这里提供 HTTP 端点；事件格式与 opencode 插件经 /ws/plugin 上报的
TimelineEvent 完全一致，服务端复用 nexus._forward_event（落库 + 转发 web 订阅者）。
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlmodel import Session as SqlSession

from server import models
from server.auth import get_current_user
from server.db import get_session
from server.nexus import _forward_event, ws_online

router = APIRouter(prefix="/api/nexus", tags=["nexus"])

_ALLOWED_KINDS = {
    "run-started",
    "text-updated",
    "reasoning-updated",
    "tool-state-changed",
    "permission-requested",
    "question-requested",
    "session-idle",
    "run-error",
}


class HookEventIn(BaseModel):
    """hook 脚本上报的事件体（req_id/kind 必带，其余字段随 kind 而定）。"""
    workspace_id: str
    event: dict = Field(default_factory=dict)


@router.post("/hook-events")
async def hook_event(
    body: HookEventIn,
    user: models.User = Depends(get_current_user),
    session: SqlSession = Depends(get_session),
):
    ws = session.get(models.Workspace, body.workspace_id)
    if ws is None or ws.user_id != user.id:
        return {"ok": False, "error": "workspace not found or not yours"}
    kind = str(body.event.get("kind", ""))
    if kind not in _ALLOWED_KINDS:
        return {"ok": False, "error": f"invalid kind: {kind}"}
    if not str(body.event.get("req_id", "")):
        return {"ok": False, "error": "req_id required"}
    # 未注册 nexus WS 的事件也照收（keepalive 可能只跑了心跳没连上 ws）
    await _forward_event(body.workspace_id, body.event)
    return {"ok": True, "plugin_online": ws_online(body.workspace_id)}
