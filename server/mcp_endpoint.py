"""MCP 端点：Streamable HTTP，所有请求经 apikey 中间件校验。

工具执行时通过 contextvar 传递当前鉴权用户，避免 FastAPI 依赖注入与
MCP SDK 工具函数签名的耦合。
"""
import contextlib
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
def register_workspace(
    path: str,
    purpose: str = "",
    capabilities: str = "",
    name: str = "",
) -> dict:
    """注册（或更新）当前 opencode 工作区。

    purpose 为空时不覆盖已有总结；返回 need_summary=true 表示该工作区
    还没有用途总结，客户端应调 LLM 生成后用 update_info 回写。

    Args:
        path: 工作目录绝对路径
        purpose: 目录用途的 AI 总结（留空 = 不修改，触发 need_summary 提示）
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
def heartbeat(workspace_id: str, session_id: str = "") -> dict:
    """工作区心跳，保持在线状态。由插件定时调用。

    Args:
        workspace_id: 注册时返回的工作区 ID
        session_id: 当前 opencode 会话 ID（可选，前台任务注入需要）
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
        session.add(ws)
        session.commit()
        return {"ok": True, "status": "online"}
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


# ---------------------------------------------------------------- help


@mcp.tool()
def request_help(
    requester_workspace_id: str,
    target_workspace_id: str,
    question: str,
    mode: str = "background",
    session_id: str = "",
) -> dict:
    """向另一个在线工作区的 agent 发起求助（异步，立即返回 request_id）。

    用 get_help_result 轮询结果。

    Args:
        requester_workspace_id: 发起求助的自己的工作区 ID
        target_workspace_id: 目标工作区 ID（从 list_workspaces 获取）
        question: 问题描述，尽量带上下文（如相关文件路径、报错信息）
        mode: 执行模式，"background"（默认，对方新会话后台执行）或
              "foreground"（注入对方当前会话执行，对方用户可见）
        session_id: 仅 background 模式：指定目标 agent 的已有会话 ID（可选）
    """
    user = get_user()
    session = next(get_session())
    try:
        src = _own_workspace(session, user, requester_workspace_id)
        tgt = session.get(models.Workspace, target_workspace_id)
        if tgt is None:
            raise ValueError(f"target workspace {target_workspace_id} not found")
        if not ws_is_online(tgt) or tgt.status == "disabled":
            raise ValueError("target workspace is not online")
        # 可见性：只能向自己的工作区求助（团队功能暂未启用）
        if tgt.user_id != user.id:
            raise ValueError("target workspace is not visible to you")
        if mode not in ("foreground", "background"):
            raise ValueError("mode must be 'foreground' or 'background'")

        import shortuuid

        hr = models.HelpRequest(
            id=shortuuid.uuid(),
            requester_ws_id=src.id,
            target_ws_id=tgt.id,
            question=question,
            mode=mode,
            session_id=session_id or None,
        )
        session.add(hr)
        session.commit()
        return {
            "request_id": hr.id,
            "status": hr.status,
            "target": {"id": tgt.id, "name": tgt.name},
        }
    finally:
        session.close()


@mcp.tool()
def get_help_result(request_id: str) -> dict:
    """查询求助请求的执行结果（轮询用）。

    Args:
        request_id: request_help 返回的请求 ID
    """
    user = get_user()
    session = next(get_session())
    try:
        hr = session.get(models.HelpRequest, request_id)
        if hr is None:
            raise ValueError(f"help request {request_id} not found")
        src = session.get(models.Workspace, hr.requester_ws_id)
        if src is None or src.user_id != user.id:
            raise ValueError("not your help request")
        return {
            "request_id": hr.id,
            "status": hr.status,
            "result": hr.result,
            "error": hr.error,
        }
    finally:
        session.close()


@mcp.tool()
def poll_help_requests(workspace_id: str) -> dict:
    """领取指向指定工作区的待处理求助任务（插件后台轮询调用）。

    Args:
        workspace_id: 自己的工作区 ID（register_workspace 返回的）
    """
    user = get_user()
    session = next(get_session())
    try:
        ws = _own_workspace(session, user, workspace_id)
        if ws.status == "disabled":
            return []
        rows = session.exec(
            select(models.HelpRequest).where(
                models.HelpRequest.target_ws_id == ws.id,
                models.HelpRequest.status == "pending",
            )
        ).all()
        out: list = []
        for hr in rows:
            hr.status = "accepted"
            hr.accepted_at = utcnow()
            session.add(hr)
            src = session.get(models.Workspace, hr.requester_ws_id)
            out.append(
                {
                    "request_id": hr.id,
                    "mode": hr.mode,
                    "session_id": hr.session_id,
                    "question": hr.question,
                    "requester": {
                        "workspace_id": src.id,
                        "name": src.name,
                        "path": src.path,
                        "purpose": src.purpose,
                    }
                    if src
                    else None,
                }
            )
        session.commit()
        return {"requests": out}
    finally:
        session.close()


@mcp.tool()
def submit_help_result(request_id: str, ok: bool, result: str = "") -> dict:
    """提交求助任务的执行结果（目标端 agent 或插件兜底调用）。

    Args:
        request_id: 求助请求 ID
        ok: 是否成功
        result: 结果内容（成功时的回复/修改说明；失败时的原因）
    """
    user = get_user()
    session = next(get_session())
    try:
        hr = session.get(models.HelpRequest, request_id)
        if hr is None:
            raise ValueError(f"help request {request_id} not found")
        tgt = session.get(models.Workspace, hr.target_ws_id)
        if tgt is None or tgt.user_id != user.id:
            raise ValueError("not your task to submit")
        if hr.status == "done":
            return {"ok": True, "status": "done", "message": "already submitted"}
        hr.status = "done" if ok else "failed"
        if ok:
            hr.result = result
        else:
            hr.error = result
        hr.done_at = utcnow()
        session.add(hr)
        session.commit()
        return {"ok": True, "status": hr.status}
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
