from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from server import models
from server.auth import get_current_user
from server.api.workspaces import visible_workspace_ids
from server.db import get_session

router = APIRouter(prefix="/api/calls", tags=["calls"])


def call_out(call: models.A2aTask, session: Session) -> dict:
    tgt_ws = session.get(models.Workspace, call.workspace_id) if call.workspace_id else None
    return {
        "id": call.id,
        "caller": None,
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
