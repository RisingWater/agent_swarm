from fastapi import APIRouter, Depends
from sqlmodel import Session

from server import models
from server.auth import get_current_user
from server.api.workspaces import visible_workspace_ids
from server.db import get_session

router = APIRouter(prefix="/api/help-requests", tags=["help-requests"])


def hr_out(hr: models.HelpRequest, session: Session) -> dict:
    req_ws = session.get(models.Workspace, hr.requester_ws_id)
    tgt_ws = session.get(models.Workspace, hr.target_ws_id)
    return {
        "id": hr.id,
        "requester": {"id": req_ws.id, "name": req_ws.name, "path": req_ws.path} if req_ws else None,
        "target": {"id": tgt_ws.id, "name": tgt_ws.name, "path": tgt_ws.path} if tgt_ws else None,
        "question": hr.question,
        "mode": hr.mode,
        "session_id": hr.session_id,
        "status": hr.status,
        "result": hr.result,
        "error": hr.error,
        "created_at": hr.created_at.isoformat() + "Z",
        "accepted_at": hr.accepted_at.isoformat() + "Z" if hr.accepted_at else None,
        "done_at": hr.done_at.isoformat() + "Z" if hr.done_at else None,
    }


@router.get("")
def list_help_requests(
    user: models.User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    ws_ids = visible_workspace_ids(user, session)
    from sqlmodel import select as _select

    rows = session.exec(_select(models.HelpRequest)).all()
    out = [hr_out(hr, session) for hr in rows if hr.requester_ws_id in ws_ids or hr.target_ws_id in ws_ids]
    out.sort(key=lambda x: x["created_at"], reverse=True)
    return out
