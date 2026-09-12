from fastapi import APIRouter, Depends
from sqlmodel import Session

from server import models
from server.auth import get_current_user
from server.api.workspaces import visible_workspace_ids
from server.db import get_session

router = APIRouter(prefix="/api/calls", tags=["calls"])


def call_out(call: models.WorkspaceCall, session: Session) -> dict:
    src_ws = session.get(models.Workspace, call.caller_ws_id)
    tgt_ws = session.get(models.Workspace, call.target_ws_id)
    return {
        "id": call.id,
        "caller": {"id": src_ws.id, "name": src_ws.name, "path": src_ws.path} if src_ws else None,
        "target": {"id": tgt_ws.id, "name": tgt_ws.name, "path": tgt_ws.path} if tgt_ws else None,
        "instruction": call.instruction,
        "status": call.status,
        "result": call.result,
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

    rows = session.exec(_select(models.WorkspaceCall)).all()
    out = [call_out(c, session) for c in rows if c.caller_ws_id in ws_ids or c.target_ws_id in ws_ids]
    out.sort(key=lambda x: x["created_at"], reverse=True)
    return out
