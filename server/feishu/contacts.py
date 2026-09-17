"""飞书用户信息解析：open_id → 真实用户名（contact:user.basic_profile:readonly）。

basic_batch 接口批量查询，结果进程内缓存（用户名极少变化）。
权限未开通/查询失败时回退 open_id 短格式，不影响主流程。
"""
import logging

import lark_oapi as lark
from lark_oapi.api.contact.v3 import BasicBatchUserRequest, BasicBatchUserRequestBody

log = logging.getLogger("nexus-feishu")

_cache: dict[str, str] = {}  # open_id → name（含回退值，避免反复打失败请求）
_client: lark.Client | None = None
_MISSING = "\x00pending"  # 占位：查询失败标记，值为空串


def set_client(client: lark.Client) -> None:
    global _client
    _client = client


def resolve_names(gateway, open_ids: list[str]) -> dict[str, str]:
    """批量解析 open_id → 用户名。gateway 提供复用的 lark client；失败回退 open_id 前 8 位。"""
    global _client
    if _client is None and gateway is not None:
        set_client(getattr(gateway, "lark", None))
    out: dict[str, str] = {}
    pending: list[str] = []
    for oid in open_ids:
        if not oid:
            continue
        if oid in _cache:
            out[oid] = _cache[oid]
        else:
            pending.append(oid)
    if pending and _client is not None:
        try:
            body = BasicBatchUserRequestBody.builder().user_ids(pending).build()
            req = BasicBatchUserRequest.builder().request_body(body).user_id_type("open_id").build()
            resp = _client.contact.v3.user.basic_batch(req)
            if resp.success() and resp.data and resp.data.users:
                users = resp.data.users or {}
                for oid in pending:
                    u = users.get(oid)
                    name = (getattr(u, "name", "") or "").strip() if u is not None else ""
                    _cache[oid] = name or _fallback(oid)
                    out[oid] = _cache[oid]
                # 查询响应里没有的 id 也标记回退，避免每次重复请求
                for oid in pending:
                    _cache.setdefault(oid, _fallback(oid))
            else:
                log.warning("飞书用户名解析失败: %s %s", resp.code, resp.msg)
                for oid in pending:
                    _cache[oid] = _fallback(oid)
                    out[oid] = _cache[oid]
        except Exception as e:  # noqa: BLE001
            log.warning("飞书用户名解析异常: %s", e)
            for oid in pending:
                _cache[oid] = _fallback(oid)
                out[oid] = _cache[oid]
    else:
        # 无可用 client（网关未启动）：回退 id 前缀但不缓存，等 client 就绪后可解析真名
        for oid in pending:
            out[oid] = _fallback(oid)
    return out


def _fallback(open_id: str) -> str:
    return f"{open_id[:8]}…"


def clear_cache() -> None:
    _cache.clear()
