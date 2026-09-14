from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from server import models
from server.auth import get_current_user
from server.api.workspaces import visible_workspace_ids
from server.db import get_session

router = APIRouter(prefix="/api/calls", tags=["calls"])


def call_out(call: models.A2aTask, session: Session) -> dict:
    tgt_ws = session.get(models.Workspace, call.workspace_id) if call.workspace_id else None
    # 发起方：内部互调 = 目标工作区自身（agent 在该工作区里发起 a2a_call）；
    # web 中枢/外部 URL = caller 渠道标注（nexus-web / agent / ...）
    if call.workspace_id and call.caller in ("", "agent"):
        caller_name = f"{tgt_ws.name} (agent)" if tgt_ws else "agent"
        caller_path = tgt_ws.path if tgt_ws else ""
    else:
        caller_name = call.caller or "a2a-client"
        caller_path = call.external_url or ""
    return {
        "id": call.id,
        "caller": {"id": call.workspace_id or "", "name": caller_name, "path": caller_path},
        "target": {"id": tgt_ws.id, "name": tgt_ws.name, "path": tgt_ws.path} if tgt_ws else None,
        "external_url": call.external_url or None,
        "instruction": call.message,
        "status": call.status,
        "result": call.artifact,
        "error": call.error,
        "created_at": call.created_at.isoformat() + "Z",
        "accepted_at": call.accepted_at.isoformat() + "Z" if call.accepted_at else None,
        "done_at": call.done_at.isoformat() + "Z" if call.done_at else None,
    }


@router.get("")
def list_calls(
    user: models.User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    ws_ids = visible_workspace_ids(user, session)
    from sqlmodel import select as _select

    rows = session.exec(_select(models.A2aTask)).all()
    out = [call_out(c, session) for c in rows if c.workspace_id in ws_ids or c.external_url]
    out.sort(key=lambda x: x["created_at"], reverse=True)
    return out


@router.delete("/{call_id}")
def delete_call(
    call_id: str,
    user: models.User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    call = session.get(models.A2aTask, call_id)
    if call is None:
        raise HTTPException(404, "call not found")
    owned = call.workspace_id in visible_workspace_ids(user, session) if call.workspace_id else bool(call.external_url)
    if not owned:
        raise HTTPException(403, "not your call")
    if call.status not in ("completed", "failed", "canceled"):
        raise HTTPException(409, "only finished tasks can be deleted")
    session.delete(call)
    session.commit()
    return {"ok": True}
