"""MCP 端点：Streamable HTTP，所有请求经 apikey 中间件校验。

工具执行时通过 contextvar 传递当前鉴权用户，避免 FastAPI 依赖注入与
MCP SDK 工具函数签名的耦合。
"""
import contextvars
import os
from datetime import datetime, timezone

from mcp.server.fastmcp import FastMCP
from sqlmodel import select
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from server import models
from server.db import get_session
from server.api.workspaces import ws_is_online

HEARTBEAT_TIMEOUT_SECONDS = 90

# 当前请求的已鉴权用户（每个 MCP 请求一个）
current_user: contextvars.ContextVar[models.User | None] = contextvars.ContextVar(
    "current_user", default=None
)


class ApiKeyMiddleware:
    """每个发到 /mcp 的请求都必须携带有效的 Authorization: Bearer <apikey>。"""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith("/mcp"):
            await self.app(scope, receive, send)
            return

        # 构造 Request 以读取 headers
        request = Request(scope, receive)
        auth = request.headers.get("Authorization", "")
        token = auth.removeprefix("Bearer ").strip() if auth.startswith("Bearer ") else ""

        session = next(get_session())
        try:
            if not token:
                resp = JSONResponse({"error": "missing api key"}, status_code=401)
                await resp(scope, receive, send)
                return
            key_hash = models.hash_api_key(token)
            user = None
            for u in session.exec(
                select(models.User).where(
                    models.User.api_key_hash == key_hash
                )
            ).all():
                user = u
                break
            if user is None or not models.api_key_matches(key_hash, user.api_key_hash):
                resp = JSONResponse({"error": "invalid api key"}, status_code=401)
                await resp(scope, receive, send)
                return
            current_user.set(user)
            await self.app(scope, receive, send)
        finally:
            session.close()


def get_user() -> models.User:
    user = current_user.get()
    if user is None:
        raise PermissionError("not authenticated")
    return user


mcp = FastMCP(
    "agent_swarm",
    json_response=True,
    stateless_http=True,
    streamable_http_path="/",
)


# ---------------------------------------------------------------- workspace


@mcp.tool()
def workspace_add(
    path: str,
    purpose: str = "",
    capabilities: str = "",
    name: str = "",
) -> dict:
    """添加（或更新）当前工作区到 agent_swarm。

    已存在同路径工作区时更新其描述。返回 workspace_id，客户端应把它写入
    项目根目录 .agent-swarm.md 的 WORKSPACE_ID: 行（插件心跳依赖该文件）。
    返回 need_summary=true 表示还没有用途总结，应生成后用 update_info 回写。

    Args:
        path: 工作目录绝对路径
        purpose: 目录用途的 AI 总结（留空 = 不修改）
        capabilities: 这个工作区能干什么（留空 = 不修改）
        name: 工作区名称，默认取目录名（可选）
    """
    user = get_user()
    session = next(get_session())
    try:
        path = path.strip().rstrip("/") or "/"

        ws = session.exec(
            select(models.Workspace).where(
                models.Workspace.user_id == user.id,
                models.Workspace.path == path,
            )
        ).first()
        now = utcnow()
        if ws is None:
            import shortuuid

            ws = models.Workspace(
                id=shortuuid.uuid(),
                user_id=user.id,
                name=name or os.path.basename(path) or path,
                path=path,
            )
            created = True
        else:
            created = False
            if name:
                ws.name = name
        if purpose:
            ws.purpose = purpose
        if capabilities:
            ws.capabilities = capabilities
        ws.agent_type = "opencode"
        ws.status = "online"
        ws.last_heartbeat = now
        ws.updated_at = now
        session.add(ws)
        session.commit()
        need_summary = not ws.purpose
        return {
            "workspace_id": ws.id,
            "created": created,
            "need_summary": need_summary,
            "purpose": ws.purpose,
            "capabilities": ws.capabilities,
            "name": ws.name,
            "status": ws.status,
        }
    finally:
        session.close()


@mcp.tool()
def workspace_remove(workspace_id: str) -> dict:
    """从 agent_swarm 移除自己的工作区（级联删除相关求助记录）。

    工作区在线时拒绝移除；请先 disable 并等心跳过期。

    Args:
        workspace_id: 工作区 ID
    """
    user = get_user()
    session = next(get_session())
    try:
        ws = _own_workspace(session, user, workspace_id)
        if ws_is_online(ws):
            raise ValueError("workspace is online, disable it and wait for heartbeat to expire first")
        session.delete(ws)
        session.commit()
        return {"ok": True, "removed": ws.id}
    finally:
        session.close()


@mcp.tool()
def workspace_enable(workspace_id: str) -> dict:
    """启用自己的工作区（状态回到 offline，等心跳恢复 online）。

    Args:
        workspace_id: 工作区 ID
    """
    user = get_user()
    session = next(get_session())
    try:
        ws = _own_workspace(session, user, workspace_id)
        ws.status = "offline"
        ws.updated_at = utcnow()
        session.add(ws)
        session.commit()
        return {"ok": True, "status": "offline"}
    finally:
        session.close()


@mcp.tool()
def workspace_disable(workspace_id: str) -> dict:
    """禁用自己的工作区：不再可见、不参与求助派发。

    Args:
        workspace_id: 工作区 ID
    """
    user = get_user()
    session = next(get_session())
    try:
        ws = _own_workspace(session, user, workspace_id)
        ws.status = "disabled"
        ws.updated_at = utcnow()
        session.add(ws)
        session.commit()
        return {"ok": True, "status": "disabled"}
    finally:
        session.close()


@mcp.tool()
def heartbeat(workspace_id: str, session_id: str = "", agent_type: str = "") -> dict:
    """工作区心跳，保持在线状态。由插件定时调用。

    Args:
        workspace_id: 注册时返回的工作区 ID
        session_id: 当前 opencode 会话 ID（可选，前台任务注入需要）
        agent_type: agent 工具类型（可选，如 opencode；重复上报会更新）
    """
    user = get_user()
    session = next(get_session())
    try:
        ws = _own_workspace(session, user, workspace_id)
        if ws.status == "disabled":
            return {"ok": False, "status": "disabled", "message": "workspace is disabled"}
        ws.status = "online"
        ws.last_heartbeat = utcnow()
        if session_id:
            ws.session_id = session_id
        if agent_type:
            ws.agent_type = agent_type.strip().lower()
        session.add(ws)
        session.commit()
        # 捎带派发：领取指向本工作区的待处理调用任务
        calls = []
        for call in session.exec(
            select(models.WorkspaceCall).where(
                models.WorkspaceCall.target_ws_id == ws.id,
                models.WorkspaceCall.status == "pending",
            )
        ).all():
            src = session.get(models.Workspace, call.caller_ws_id)
            calls.append(
                {
                    "call_id": call.id,
                    "instruction": call.instruction,
                    "caller": {
                        "workspace_id": src.id,
                        "name": src.name,
                        "path": src.path,
                    }
                    if src
                    else None,
                }
            )
        return {"ok": True, "status": "online", "calls": calls}
    finally:
        session.close()


@mcp.tool()
def update_notes(workspace_id: str, notes: str, append: bool = True) -> dict:
    """更新工作区备注（/swarm-note 命令）。

    Args:
        workspace_id: 工作区 ID
        notes: 备注内容
        append: true 追加到已有备注，false 覆盖
    """
    user = get_user()
    session = next(get_session())
    try:
        ws = _own_workspace(session, user, workspace_id)
        if append and ws.notes:
            ws.notes = f"{ws.notes}\n{notes}"
        else:
            ws.notes = notes
        ws.updated_at = utcnow()
        session.add(ws)
        session.commit()
        return {"ok": True, "notes": ws.notes}
    finally:
        session.close()


@mcp.tool()
def update_info(
    workspace_id: str,
    purpose: str = "",
    capabilities: str = "",
) -> dict:
    """更新工作区用途/能力描述（/swarm-desc 命令）。

    Args:
        workspace_id: 工作区 ID
        purpose: 新的用途描述（空字符串表示不修改）
        capabilities: 新的能力描述（空字符串表示不修改）
    """
    user = get_user()
    session = next(get_session())
    try:
        ws = _own_workspace(session, user, workspace_id)
        if purpose:
            ws.purpose = purpose
        if capabilities:
            ws.capabilities = capabilities
        ws.updated_at = utcnow()
        session.add(ws)
        session.commit()
        return {"ok": True, "purpose": ws.purpose, "capabilities": ws.capabilities}
    finally:
        session.close()


@mcp.tool()
def list_workspaces(include_offline: bool = False) -> dict:
    """列出当前用户可见的 agent 工作区（自己创建的）。

    默认只返回在线且启用的工作区；请求方可直接挑选目标发起求助。

    Args:
        include_offline: 是否包含离线工作区（默认 false）
    """
    user = get_user()
    session = next(get_session())
    try:
        mine = session.exec(
            select(models.Workspace).where(models.Workspace.user_id == user.id)
        ).all()
        out = []
        for ws in mine:
            online = ws_is_online(ws)
            if not include_offline and not online:
                continue
            owner = session.get(models.User, ws.user_id)
            out.append(
                {
                    "workspace_id": ws.id,
                    "name": ws.name,
                    "path": ws.path,
                    "purpose": ws.purpose,
                    "capabilities": ws.capabilities,
                    "notes": ws.notes,
                    "status": "online" if online else ("disabled" if ws.status == "disabled" else "offline"),
                    "owner": owner.username if owner else None,
                    "is_self": ws.user_id == user.id,
                    "last_heartbeat": ws.last_heartbeat.isoformat() + "Z" if ws.last_heartbeat else None,
                }
            )
        return {"workspaces": out}
    finally:
        session.close()


# ---------------------------------------------------------------- workspace_call


CALL_TIMEOUT_SECONDS = int(os.environ.get("AGENT_SWARM_CALL_TIMEOUT", "3600"))


@mcp.tool()
def workspace_call(target_workspace_id: str, instruction: str) -> dict:
    """调用另一个在线工作区的 agent 执行任务（异步，立即返回 call_id）。

    先用 list_workspaces 找到目标工作区，再用本工具发起调用，
    之后用 workspace_call_status 轮询结果。

    Args:
        target_workspace_id: 目标工作区 ID（从 list_workspaces 获取）
        instruction: 要目标 agent 执行的任务指令，尽量具体（涉及文件写绝对路径）

    注意：允许调用自身工作区（自测试用），生产中请调用其他工作区。
    """
    user = get_user()
    session = next(get_session())
    try:
        src = session.exec(
            select(models.Workspace).where(models.Workspace.user_id == user.id)
        ).all()
        # 调用方必须也有一个自己的工作区（发起调用的主体）
        caller = next((w for w in src if w.id != target_workspace_id), None)
        if caller is None:
            raise ValueError("you need your own workspace to make calls (workspace_add first)")
        tgt = session.get(models.Workspace, target_workspace_id)
        if tgt is None or tgt.user_id != user.id:
            raise ValueError(f"target workspace {target_workspace_id} not found or not visible to you")
        if (tgt.agent_type or "").strip().lower() == "claude":
            raise ValueError("claude workspace does not support task execution yet (keepalive only)")
        if not ws_is_online(tgt) or tgt.status == "disabled":
            raise ValueError("target workspace is not online")

        import shortuuid

        call = models.WorkspaceCall(
            id=shortuuid.uuid(),
            caller_ws_id=caller.id,
            target_ws_id=tgt.id,
            instruction=instruction,
        )
        session.add(call)
        session.commit()
        return {
            "call_id": call.id,
            "status": call.status,
            "target": {"id": tgt.id, "name": tgt.name},
        }
    finally:
        session.close()


@mcp.tool()
def workspace_call_status(call_id: str) -> dict:
    """查询 workspace_call 的状态与结果（轮询用）。

    Args:
        call_id: workspace_call 返回的调用 ID
    """
    user = get_user()
    session = next(get_session())
    try:
        call = session.get(models.WorkspaceCall, call_id)
        if call is None:
            raise ValueError(f"workspace call {call_id} not found")
        caller = session.get(models.Workspace, call.caller_ws_id)
        if caller is None or caller.user_id != user.id:
            raise ValueError("not your call")
        # 超时兜底：running 超时标记 failed
        if call.status == "running" and call.accepted_at:
            accepted = call.accepted_at if call.accepted_at.tzinfo else call.accepted_at.replace(tzinfo=timezone.utc)
            if (datetime.now(timezone.utc) - accepted).total_seconds() > CALL_TIMEOUT_SECONDS:
                call.status = "failed"
                call.error = f"timeout after {CALL_TIMEOUT_SECONDS}s"
                call.done_at = utcnow()
                session.add(call)
                session.commit()
        return {
            "call_id": call.id,
            "status": call.status,
            "result": call.result,
            "error": call.error,
        }
    finally:
        session.close()


@mcp.tool()
def workspace_call_ack(call_id: str, session_id: str = "") -> dict:
    """确认领取调用任务（插件内部用，agent 不要调用）。

    Args:
        call_id: 调用 ID（heartbeat 响应的 calls 里获得）
        session_id: 执行该任务的 opencode 会话 ID
    """
    user = get_user()
    session = next(get_session())
    try:
        call = session.get(models.WorkspaceCall, call_id)
        if call is None:
            raise ValueError(f"workspace call {call_id} not found")
        tgt = session.get(models.Workspace, call.target_ws_id)
        if tgt is None or tgt.user_id != user.id:
            raise ValueError("not your task to ack")
        if call.status != "pending":
            return {"ok": True, "status": call.status, "message": "already taken"}
        call.status = "running"
        call.accepted_at = utcnow()
        if session_id:
            call.session_id = session_id
        session.add(call)
        session.commit()
        return {"ok": True, "status": "running"}
    finally:
        session.close()


@mcp.tool()
def workspace_call_result(call_id: str, ok: bool, result: str = "") -> dict:
    """提交调用任务的执行结果（插件内部用，agent 不要调用）。

    Args:
        call_id: 调用 ID
        ok: 是否成功完成
        result: 结果内容（成功时的答复；失败时的原因）
    """
    user = get_user()
    session = next(get_session())
    try:
        call = session.get(models.WorkspaceCall, call_id)
        if call is None:
            raise ValueError(f"workspace call {call_id} not found")
        tgt = session.get(models.Workspace, call.target_ws_id)
        if tgt is None or tgt.user_id != user.id:
            raise ValueError("not your task to submit")
        if call.status in ("done", "failed"):
            return {"ok": True, "status": call.status, "message": "already submitted"}
        call.status = "done" if ok else "failed"
        if ok:
            call.result = result
        else:
            call.error = result
        call.done_at = utcnow()
        session.add(call)
        session.commit()
        return {"ok": True, "status": call.status}
    finally:
        session.close()


# ---------------------------------------------------------------- helpers

def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _own_workspace(session, user: models.User, workspace_id: str) -> models.Workspace:

    ws = session.get(models.Workspace, workspace_id) if workspace_id else None
    if ws is None or ws.user_id != user.id:
        raise ValueError(f"workspace {workspace_id!r} not found or not owned by you")
    return ws


def build_mcp_asgi_app() -> ASGIApp:
    """返回挂载到 /mcp 的 ASGI app（含 apikey 中间件）。"""
    inner = mcp.streamable_http_app()
    return ApiKeyMiddleware(inner)


def mcp_lifespan():
    """宿主 FastAPI 的 lifespan 内运行 MCP session manager（异步上下文管理器）。"""
    mcp.streamable_http_app()  # 触发 session manager 惰性创建
    return mcp.session_manager.run()
