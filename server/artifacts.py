"""产物存储：文件落盘 + 一次性上传凭证 + 签名下载 URL + TTL 清理。

链路（无 base64）：agent 先用 MCP artifact_upload 换取一次性上传 URL，
再用 curl -F file=@路径 直传原始字节（multipart 流式落盘）。
签名 URL（下载）与上传凭证共用 HMAC(secret) 格式；上传凭证额外一次性防重放。
"""
import hashlib
import hmac
import secrets
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from server import config, models

PROJECT_ROOT = Path(__file__).resolve().parent.parent
STORAGE_DIR = Path("/app/data/artifacts") if Path("/app/data").exists() else PROJECT_ROOT / "data" / "artifacts"

TTL_DAYS = config.get_int("AGENT_SWARM_ARTIFACT_TTL_DAYS", 7)
MAX_MB = config.get_int("AGENT_SWARM_ARTIFACT_MAX_MB", 20)
UPLOAD_TOKEN_TTL_SECONDS = 600  # MCP 签发 → curl 直传的窗口
DOWNLOAD_TTL_SECONDS = 30 * 86400  # 签名下载链接有效期（IM/网页点击场景）

# 一次性上传凭证防重放（进程内 set；重启失效 = 凭证本来就带时间戳限制，可接受）
_used_upload_tokens: set[str] = set()


def _secret() -> bytes:
    """签名密钥：JWT secret（与鉴权同源；专用 env 可覆盖）。"""
    return config.get("AGENT_SWARM_ARTIFACT_SECRET") or config.get("AGENT_SWARM_JWT_SECRET") or "agent-swarm-dev-secret"


def _sig(payload: str) -> str:
    return hmac.new(_secret().encode(), payload.encode(), hashlib.sha256).hexdigest()[:32]


def _sign(payload: str, exp: int) -> str:
    return f"{exp}.{_sig(f'{payload}.{exp}')}"


def _verify(payload: str, token: str) -> bool:
    try:
        exp_s, sig = token.split(".", 1)
        exp = int(exp_s)
    except ValueError:
        return False
    if exp < int(time.time()):
        return False
    return hmac.compare_digest(sig, _sig(f"{payload}.{exp}"))


def sign_upload_token(user_id: str, nonce: str) -> str:
    """一次性上传凭证（payload 含 nonce，10 分钟有效）。"""
    exp = int(time.time()) + UPLOAD_TOKEN_TTL_SECONDS
    return _sign(f"up:{user_id}:{nonce}", exp)


def verify_upload_token(user_id: str, nonce: str, token: str) -> bool:
    if token in _used_upload_tokens:
        return False
    ok = _verify(f"up:{user_id}:{nonce}", token)
    if ok:
        _used_upload_tokens.add(token)
        if len(_used_upload_tokens) > 4096:
            _used_upload_tokens.clear()  # 极端堆积兜底，防内存涨
    return ok


def sign_download(user_id: str, artifact_id: str, ttl_seconds: int = DOWNLOAD_TTL_SECONDS) -> str:
    """签名下载 token（下载端点用它免 JWT）。"""
    exp = int(time.time()) + ttl_seconds
    return _sign(f"dl:{user_id}:{artifact_id}", exp)


def verify_download(user_id: str, artifact_id: str, token: str) -> bool:
    return _verify(f"dl:{user_id}:{artifact_id}", token)


def file_path(artifact_id: str, name: str) -> Path:
    """落盘路径：<id>_<安全化文件名>。"""
    safe = "".join(c if c.isalnum() or c in "._- " else "_" for c in name).strip() or "file"
    return STORAGE_DIR / f"{artifact_id}_{safe}"[:200]


def public_base_url() -> str:
    """对外可达基址（签名链接拼进 IM/网页）。未配 PUBLIC_URL 时由调用方从 request 派生。"""
    return config.get("AGENT_SWARM_PUBLIC_URL").rstrip("/")


def base_url_from_request(request) -> str:
    """PUBLIC_URL 未配置时从请求头派生（对齐 nexus_a2a._base_url 的转发头处理）。"""
    public = public_base_url()
    if public:
        return public
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("x-forwarded-host", request.headers.get("host", request.url.netloc))
    return f"{proto}://{host}"


def download_url(row: models.Artifact, base: str = "") -> str:
    base = (base or public_base_url()).rstrip("/")
    token = sign_download(row.user_id, row.id)
    return f"{base}/api/artifacts/{row.id}/download?token={token}"


def new_row(user_id: str, name: str, size: int, mime: str, note: str = "",
            task_id: str = "", workspace_id: str = "") -> models.Artifact:
    return models.Artifact(
        id=uuid.uuid4().hex[:12],
        user_id=user_id,
        name=name,
        size=size,
        mime=mime or "application/octet-stream",
        note=note,
        task_id=task_id,
        workspace_id=workspace_id,
        expires_at=datetime.now(timezone.utc) + timedelta(days=TTL_DAYS),
    )


def cleanup_expired() -> int:
    """删除过期未固定的产物（文件 + 行）。返回清理条数；启动时与每小时协程共用。"""
    from sqlmodel import Session, select

    from server.db import engine

    # DB 时间列是 naive UTC（项目约定 models.utcnow），比较前统一
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    n = 0
    with Session(engine) as session:
        rows = list(session.exec(
            select(models.Artifact)
            .where(models.Artifact.pinned == False)  # noqa: E712
            .where(models.Artifact.expires_at < now)  # type: ignore[operator]
        ).all())
        for row in rows:
            try:
                p = file_path(row.id, row.name)
                if p.exists():
                    p.unlink()
            except OSError:
                pass
            session.delete(row)
            n += 1
        if n:
            session.commit()
    return n
