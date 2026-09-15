"""MCP 端点：Streamable HTTP，所有请求经 apikey 中间件校验。

工具执行时通过 contextvar 传递当前鉴权用户，避免 FastAPI 依赖注入与
MCP SDK 工具函数签名的耦合。
"""
import contextvars
import os
from datetime import datetime, timezone

import shortuuid

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
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
    # MCP SDK 默认开 DNS rebinding 防护（Host 校验只放行 127.0.0.1/localhost），
    # 局域网/远程客户端（10.x 等）会被 421 Misdirected Request 拒掉。
    # 本服务有自己的 ApiKeyMiddleware 鉴权，Host 防护显式关闭。
    # 注意：传 None 时 SDK 会在 host 为 127.0.0.1 时自动再开防护，必须显式传 disabled 实例。
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
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
    项目根目录 .agent_swarm/workspace.md 的 WORKSPACE_ID: 行（插件心跳依赖该文件）。
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
def heartbeat(
    workspace_id: str,
    session_id: str = "",
    session_title: str = "",
    agent_type: str = "",
) -> dict:
    """工作区心跳，保持在线状态。由插件定时调用。

    Args:
        workspace_id: 注册时返回的工作区 ID
        session_id: 当前 opencode 会话 ID（可选，前台任务注入需要）
        session_title: 当前会话标题（可选，web 展示用）
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
        if session_title:
            ws.session_title = session_title[:200]
        if agent_type:
            ws.agent_type = agent_type.strip().lower()
        session.add(ws)
        session.commit()
        # 任务派发已改走 nexus_a2a WS 链路（message/send → 插件实时推送 + 上线补推），
        # heartbeat 只负责保活，不再捎带任务
        return {"ok": True, "status": "online"}
    finally:
        session.close()


@mcp.tool()
def workspace_offline(workspace_id: str) -> dict:
    """主动下线：插件/保活进程退出前调用，立即把工作区置为离线（不等 90s 心跳超时）。

    幂等：重复调用无害。disabled 状态保持不变（不能靠它绕过 disable）。
    """
    user = get_user()
    session = next(get_session())
    try:
        ws = _own_workspace(session, user, workspace_id)
        if ws.status != "disabled":
            ws.status = "offline"
            ws.updated_at = utcnow()
            session.add(ws)
            session.commit()
        return {"ok": True, "status": ws.status}
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


# ---------------------------------------------------------------- a2a_call / a2a_task


CALL_TIMEOUT_SECONDS = int(os.environ.get("AGENT_SWARM_CALL_TIMEOUT", "3600"))


@mcp.tool()
async def a2a_call(target: str, message: str, context_id: str = "") -> dict:
    """通过 A2A 协议给另一个 agent 发任务（支持内部工作区与外部 A2A agent）。

    用 list_workspaces 找内部工作区（传 workspace ID），或直接传外部 agent 的
    A2A 端点 URL（如 https://host/a2a/agent-id）。返回 task_id，用 a2a_task 轮询结果。

    Args:
        target: 内部工作区 ID，或外部 A2A agent 端点 URL
        message: 任务指令，尽量具体（涉及文件写绝对路径）
        context_id: 可选，延续之前的会话上下文（多轮任务）
    """
    from server.nexus_a2a import call_external

    user = get_user()
    session = next(get_session())
    try:
        if target.startswith("http://") or target.startswith("https://"):
            # 外部 A2A agent：message/send 非流式，等终态返回
            task_id, ctx, status = await call_external(target, message, context_id=context_id)
            task = models.A2aTask(
                id=task_id or shortuuid.uuid(),
                context_id=ctx,
                external_url=target,
                caller="agent",
                message=message,
                status=status if status in ("queued", "working", "input-required", "completed", "failed", "canceled") else "working",
            )
            if task.status in ("completed", "failed", "canceled"):
                task.done_at = utcnow()
            session.add(task)
            session.commit()
            return {
                "task_id": task.id,
                "context_id": task.context_id,
                "status": task.status,
                "target": target,
                "note": "external A2A agent; poll with a2a_task",
            }
        # 内部工作区：落 queued 任务，WS 实时推给目标插件
        tgt = session.get(models.Workspace, target)
        if tgt is None or tgt.user_id != user.id:
            raise ValueError(f"target workspace {target!r} not found or not visible to you")
        if tgt.status == "disabled":
            raise ValueError("target workspace is disabled")
        from server.nexus_a2a import ws_online as _ws_plugin_online

        online = _ws_plugin_online(tgt.id)
        if not online and not ws_is_online(tgt):
            raise ValueError("target workspace is not online")
        task = models.A2aTask(
            id=shortuuid.uuid(),
            context_id=context_id or shortuuid.uuid(),
            workspace_id=tgt.id,
            caller="agent",
            message=message,
            status="queued",
        )
        session.add(task)
        session.commit()
        if online:
            # 插件 WS 在线：立即派发（离线则等插件重连时补推）
            import asyncio

            from server.nexus_a2a import dispatch_queued_for

            asyncio.ensure_future(dispatch_queued_for(tgt.id))
        return {
            "task_id": task.id,
            "context_id": task.context_id,
            "status": task.status,
            "target": {"id": tgt.id, "name": tgt.name},
            "note": "poll with a2a_task",
        }
    finally:
        session.close()


@mcp.tool()
def a2a_task(task_id: str) -> dict:
    """查询 A2A 任务的状态与结果（a2a_call 后轮询用）。

    Args:
        task_id: a2a_call 返回的任务 ID
    """
    user = get_user()
    session = next(get_session())
    try:
        task = session.get(models.A2aTask, task_id)
        if task is None:
            raise ValueError(f"task {task_id} not found")
        # 归属校验：内部任务看工作区属主；外部任务记录创建人（简化：caller + 外部不校验属主，MCP 层已按用户隔离）
        if task.workspace_id:
            ws = session.get(models.Workspace, task.workspace_id)
            if ws is None or ws.user_id != user.id:
                raise ValueError("not your task")
        # 超时兜底：working/queued 超时标记 failed
        if task.status in ("queued", "working") and task.created_at:
            created = task.created_at if task.created_at.tzinfo else task.created_at.replace(tzinfo=timezone.utc)
            if (datetime.now(timezone.utc) - created).total_seconds() > CALL_TIMEOUT_SECONDS:
                task.status = "failed"
                task.error = f"timeout after {CALL_TIMEOUT_SECONDS}s"
                task.done_at = utcnow()
                session.add(task)
                session.commit()
        out = {
            "task_id": task.id,
            "context_id": task.context_id,
            "status": task.status,
            "result": task.artifact,
            "error": task.error,
        }
        if task.status == "input-required":
            out["note"] = "task needs input (permission/question); reply via web nexus page"
        return out
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
