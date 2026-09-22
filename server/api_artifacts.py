"""产物 REST 端点（JWT 鉴权；下载走签名 token 免 JWT）。

上传两步走（无 base64）：
1) agent 通过 MCP artifact_upload 拿一次性 upload_url + token
2) agent curl -F file=@路径 直传本端点，multipart 原始字节流式落盘
"""
import json
import re

from fastapi import HTTPException, Request
from sqlmodel import Session, select
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Route

from server import artifacts, models
from server.auth import JWT_SECRET  # noqa: F401（占位引用，实际校验在 _require_jwt）
from server.db import engine
from server.nexus_a2a import _auth_jwt

_FILENAME_RE = re.compile(r"^[\w.\- ()\[\]（）、，。]{1,120}$")


async def _require_jwt(request: Request) -> models.User:
    auth = request.headers.get("authorization", "")
    token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    user = _auth_jwt(token)
    if user is None:
        raise HTTPException(401, "invalid token")
    return user


def _out(row: models.Artifact, base: str = "") -> dict:
    from datetime import datetime, timezone

    exp = row.expires_at.replace(tzinfo=timezone.utc) if row.expires_at and row.expires_at.tzinfo is None else row.expires_at
    remain_days = max(0, (exp - datetime.now(timezone.utc)).days) if exp else 0
    return {
        "id": row.id,
        "name": row.name,
        "size": row.size,
        "mime": row.mime,
        "note": row.note,
        "task_id": row.task_id,
        "workspace_id": row.workspace_id,
        "pinned": row.pinned,
        "created_at": row.created_at.isoformat() if row.created_at else "",
        "expires_at": row.expires_at.isoformat() if row.expires_at else "",
        "remain_days": remain_days,
        "download_url": artifacts.download_url(row, base),
    }


async def upload(request: Request):
    """一次性凭证直传端点（免 JWT）：?token=<MCP 签发的一次性凭证>&nonce=...。"""
    nonce = request.query_params.get("nonce", "")
    token = request.query_params.get("token", "")
    if not nonce or not token:
        return JSONResponse({"error": "nonce and token are required"}, 422)
    # nonce 里编了 user_id（<uid>.<rand>），先解析出 user_id 才能验签
    uid = nonce.split(".", 1)[0]
    if not uid or not artifacts.verify_upload_token(uid, nonce, token):
        return JSONResponse({"error": "upload token invalid or expired (one-time)"}, 401)
    content_type = request.headers.get("content-type", "")
    if "multipart/form-data" not in content_type:
        return JSONResponse({"error": "multipart/form-data required: curl -F file=@path"}, 415)

    from starlette.datastructures import UploadFile
    from starlette.formparsers import MultiPartParser

    # 表单字段：name/note/task_id/workspace_id 可走 query 或 form
    q = request.query_params
    name = q.get("name", "")
    note = q.get("note", "")
    task_id = q.get("task_id", "")
    workspace_id = q.get("workspace_id", "")

    parser = MultiPartParser(request.headers, request.stream(), max_part_size=artifacts.MAX_MB * 1024 * 1024)
    form = await parser.parse()
    upload_file = form.get("file")
    if upload_file is None or not isinstance(upload_file, UploadFile):
        return JSONResponse({"error": "missing multipart field: file"}, 422)
    if not name:
        name = upload_file.filename or "file"
    if not _FILENAME_RE.match(name):
        name = re.sub(r"[^\w.\- ]", "_", name)[:120]
    note = str(form.get("note", note) or "")[:2000]
    task_id = str(form.get("task_id", task_id) or "")[:80]
    workspace_id = str(form.get("workspace_id", workspace_id) or "")[:80]

    # 上限校验（Starlette spooled file 超限也在此拦截）
    data = await upload_file.read()
    if not data:
        return JSONResponse({"error": "empty file"}, 422)
    if len(data) > artifacts.MAX_MB * 1024 * 1024:
        return JSONResponse({"error": f"file too large (max {artifacts.MAX_MB}MB)"}, 413)

    row = artifacts.new_row(uid, name, len(data), upload_file.content_type or "", note, task_id, workspace_id)
    dest = artifacts.file_path(row.id, row.name)
    artifacts.STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    with Session(engine) as session:
        session.add(row)
        session.commit()
        session.refresh(row)
    out = _out(row, artifacts.base_url_from_request(request))
    # 异步触发 IM 推送（飞书/微信，跟简报推送规则一致；链接基址取自上传请求）
    import asyncio

    asyncio.ensure_future(_push_to_channels(row, artifacts.base_url_from_request(request)))
    return JSONResponse(out, 200)


async def _push_to_channels(row: models.Artifact, base: str = "") -> None:
    try:
        from server.feishu.file_push import push_artifact as feishu_push
        await feishu_push(row, base)
    except Exception:  # noqa: BLE001
        pass
    try:
        from server.weixin.file_push import push_artifact as weixin_push
        await weixin_push(row, base)
    except Exception:  # noqa: BLE001
        pass


async def list_artifacts(request: Request):
    user = await _require_jwt(request)
    with Session(engine) as session:
        rows = list(session.exec(
            select(models.Artifact)
            .where(models.Artifact.user_id == user.id)
            .order_by(models.Artifact.created_at.desc())  # type: ignore[attr-defined]
        ).all())
    base = artifacts.base_url_from_request(request)
    return JSONResponse([_out(r, base) for r in rows])


async def delete_artifact(request: Request):
    user = await _require_jwt(request)
    aid = request.path_params["artifact_id"]
    with Session(engine) as session:
        row = session.get(models.Artifact, aid)
        if row is None or row.user_id != user.id:
            raise HTTPException(404, "artifact not found")
        try:
            artifacts.file_path(row.id, row.name).unlink(missing_ok=True)
        except OSError:
            pass
        session.delete(row)
        session.commit()
    return JSONResponse({"ok": True})


async def pin_artifact(request: Request):
    """固定/取消固定（pinned 不参与 TTL 清理）。body: {pinned: bool}"""
    user = await _require_jwt(request)
    aid = request.path_params["artifact_id"]
    try:
        body = json.loads((await request.body()) or b"{}")
    except json.JSONDecodeError:
        body = {}
    pinned = bool(body.get("pinned", True))
    with Session(engine) as session:
        row = session.get(models.Artifact, aid)
        if row is None or row.user_id != user.id:
            raise HTTPException(404, "artifact not found")
        row.pinned = pinned
        session.add(row)
        session.commit()
        out = _out(row, artifacts.base_url_from_request(request))
    return JSONResponse(out)


async def download(request: Request):
    """签名链接下载（免 JWT，IM/浏览器点击场景）。"""
    aid = request.path_params["artifact_id"]
    token = request.query_params.get("token", "")
    with Session(engine) as session:
        row = session.get(models.Artifact, aid)
        if row is None:
            return JSONResponse({"error": "artifact not found"}, 404)
        if not artifacts.verify_download(row.user_id, aid, token):
            return JSONResponse({"error": "download link invalid or expired"}, 403)
        path = artifacts.file_path(row.id, row.name)
        if not path.exists():
            return JSONResponse({"error": "file missing (expired?)"}, 410)
        return FileResponse(path, filename=row.name, media_type=row.mime)


routes = [
    Route("/api/artifacts/upload", upload, methods=["POST"]),
    Route("/api/artifacts", list_artifacts, methods=["GET"]),
    Route("/api/artifacts/{artifact_id}", delete_artifact, methods=["DELETE"]),
    Route("/api/artifacts/{artifact_id}/pin", pin_artifact, methods=["PUT"]),
    Route("/api/artifacts/{artifact_id}/download", download, methods=["GET"]),
]
