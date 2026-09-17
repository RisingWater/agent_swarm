from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from server import models
from server.auth import get_current_user
from server.api.workspaces import visible_workspace_ids
from server.db import get_session

router = APIRouter(prefix="/api/calls", tags=["calls"])


def call_out(call: models.A2aTask, session: Session) -> dict:
    tgt_ws = session.get(models.Workspace, call.workspace_id) if call.workspace_id else None
    from_ws = session.get(models.Workspace, call.from_workspace_id) if call.from_workspace_id else None
    # 发起方优先级：
    # 1) from_workspace_id（a2a_call 显式传入的真实发起工作区）
    # 2) monitor（前台监控轮）= 工作区自己（发送和接收都是它）
    # 3) agent 互调但发起方未注明 → "agent（发起方未注明）"，不再拿目标工作区冒充
    # 4) 其余 = caller 渠道标注（nexus-web / a2a-client / ...）
    if from_ws is not None:
        caller_name = from_ws.name
        caller_path = from_ws.path
    elif call.caller == "monitor" and tgt_ws is not None:
        caller_name = f"{tgt_ws.name} (monitor)"
        caller_path = tgt_ws.path
    elif call.workspace_id and call.caller in ("", "agent"):
        caller_name = "agent（发起方未注明）"
        caller_path = ""
    else:
        caller_name = call.caller or "a2a-client"
        caller_path = call.external_url or ""
    caller_id = call.from_workspace_id if from_ws is not None else (call.workspace_id or "")
    return {
        "id": call.id,
        "monitor": call.caller == "monitor",
        "caller": {"id": caller_id, "name": caller_name, "path": caller_path},
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
    workspace_id: str = "",
    user: models.User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """调用记录（调用方向 = a2a_tasks 表，含 A2A 任务与前台监控轮）。

    workspace_id 非空时按执行工作区过滤（web 调用记录页要求先选工作区）。
    """
    ws_ids = visible_workspace_ids(user, session)
    stmt = select(models.A2aTask)
    if workspace_id:
        if workspace_id not in ws_ids:
            raise HTTPException(404, "workspace not found")
        stmt = stmt.where(models.A2aTask.workspace_id == workspace_id)
    rows = session.exec(stmt).all()
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
    # 监控轮级联删事件（任务行删除后事件失去分组意义）
    for ev in session.exec(
        select(models.A2aEvent).where(models.A2aEvent.task_id == call_id)
    ).all():
        session.delete(ev)
    session.delete(call)
    session.commit()
    return {"ok": True}
