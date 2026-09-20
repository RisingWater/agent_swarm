"""静态内容落库加密（可选，由 AGENT_SWARM_ENC_KEY 开启）。

设计（2026-09-19 用户拍板）：
- .env 不配置密钥 = 全明文落库，行为与历史版本完全一致
- 配置后，敏感内容列（workspaces.purpose/notes/session_title、a2a_tasks.message/
  artifact/error、a2a_events.payload）写入 *_enc 密文列并清空明文列
- 密钥体系：用户子密钥 = sha256(服务器密钥 + ":" + 用户 api_key)，每用户独立；
  可选恢复密钥（AGENT_SWARM_ENC_KEY_RECOVERY）派生一套兜底子密钥。
  只拿走 DB 文件（有 apikey 明文）解不开，必须同时拿到 .env 里的服务器密钥
- 密文格式 "enc1:<fernet token>"：版本前缀为将来密钥轮换留路
- 解密尝试顺序：主服务器密钥派生的用户子密钥 → 恢复密钥派生的用户子密钥。
  写入永远用"主服务器密钥 + 用户 api_key"
- 读统一走 decrypt()：密文有效→解密；密文缺失/损坏/密钥不匹配→回退明文列。
  因此"服务器密钥丢失"的后果 = 密文历史内容永久不可读（内容列读出为空），
  平台本身（账号/工作区结构/状态/调用元数据）不受影响，新数据用新密钥继续存
- init_db 时存量明文幂等回填成密文并清空明文列（外部任务无属主，保持明文）

注意：users.api_key 本身仍是明文列（登录后要回显）——它不是秘密的最终防线，
服务器密钥才是；两者不同存即可。
"""
import base64
import hashlib
import threading

from cryptography.fernet import Fernet, InvalidToken

from server import config

PREFIX = "enc1:"

_lock = threading.Lock()
_cache: dict | None = None  # {"server_keys": [str, ...]} | None


def _fernet(server_key: str, user_api_key: str) -> Fernet:
    """用户子密钥：sha256(服务器密钥 + ":" + 用户 api_key) → Fernet key。"""
    digest = hashlib.sha256(f"{server_key}:{user_api_key}".encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def _load() -> dict:
    global _cache
    with _lock:
        if _cache is None:
            main = config.get("AGENT_SWARM_ENC_KEY")
            recovery = config.get("AGENT_SWARM_ENC_KEY_RECOVERY")
            keys = [main] if main else []
            if recovery:
                keys.append(recovery)
            _cache = {"server_keys": keys}
        return _cache


def enabled() -> bool:
    """是否启用落库加密（.env 配了 AGENT_SWARM_ENC_KEY 即开启）。"""
    return bool(_load()["server_keys"])


def encrypt(user_api_key: str, text: str | None) -> str | None:
    """加密文本；未启用/空文本返回 None（调用方保持明文列为空串）。"""
    keys = _load()["server_keys"]
    if not keys or not text:
        return None
    token = _fernet(keys[0], user_api_key).encrypt(text.encode())
    return PREFIX + token.decode()


def decrypt(user_api_key: str, enc: str | None, plain: str | None = "") -> str:
    """优先解密 *_enc 列；空/损坏/密钥不匹配回退明文列（天然容忍密钥丢失）。

    依次尝试主服务器密钥、恢复密钥派生的子密钥。
    """
    keys = _load()["server_keys"]
    if not enc:
        return plain or ""
    if not keys or not enc.startswith(PREFIX):
        return plain or ""
    token = enc[len(PREFIX):].encode()
    for server_key in keys:
        try:
            return _fernet(server_key, user_api_key).decrypt(token).decode()
        except (InvalidToken, ValueError):
            continue
    return plain or ""


def user_apikeys(session) -> dict[str, str]:
    """批量取 user_id → 明文 apikey（读侧解密用；一次查询防 N+1）。"""
    from sqlmodel import select

    from server import models

    return {u.id: (u.api_key or "") for u in session.exec(select(models.User)).all()}
