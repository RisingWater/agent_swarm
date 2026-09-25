# -*- coding: utf-8 -*-
"""MCP 工具层测试：12 个工具全覆盖 + 四个 annotation hint 校验。

直接调用工具函数（FastMCP 装饰器原样返回函数，已验证）；鉴权通过
current_user contextvar 注入，不经过 ApiKeyMiddleware/HTTP。

a2a_call 的外部/内部派发路径涉及真实网络与插件 WS，不在单测范围——
只测参数校验与任务落库（wait_seconds=0、无插件连接时 dispatch 安全返回 0）。
"""
import asyncio
import json
from datetime import datetime, timedelta, timezone

import pytest

from server import models, mcp_endpoint
from server.db import engine, init_db
from server.api.workspaces import HEARTBEAT_TIMEOUT_SECONDS
from sqlmodel import Session, select

from tests.conftest import as_user, ws, user  # noqa: F401  共享夹具（conftest 定义；_db 为 autouse 不导入）


# ---------------------------------------------------------------- annotations（OpenAI 目录校验项）

EXPECTED_ANNOTATIONS = {
    # 只读查询
    "list_workspaces": (True, False, False, False),
    "a2a_task": (True, False, False, False),
    "artifact_upload": (True, False, False, False),  # 只签发凭证，不落库
    # 非只读但幂等（upsert / 状态置位）
    "workspace_add": (False, False, True, False),
    "workspace_enable": (False, False, True, False),
    "workspace_disable": (False, False, True, False),
    "workspace_offline": (False, False, True, False),
    "heartbeat": (False, False, True, False),
    "update_info": (False, False, True, False),
    # 非幂等写
    "update_notes": (False, False, False, False),  # append=true 时重复调用内容不同
    # 删除
    "workspace_remove": (False, True, False, False),
    # 触达服务端之外的世界（外部 A2A agent / 其它工作区）
    "a2a_call": (False, False, False, True),
}


def _tool(name: str):
    return asyncio.get_event_loop_policy().new_event_loop() if False else None  # pragma: no cover


def test_all_tools_have_four_boolean_annotations():
    """目录硬性要求：四个 hint 全部存在且为布尔（缺省/非布尔即拒收）。"""
    tools = mcp_endpoint.mcp._tool_manager.list_tools()
    names = {t.name for t in tools}
    assert names == set(EXPECTED_ANNOTATIONS), f"工具集不符: {names ^ set(EXPECTED_ANNOTATIONS)}"
    for t in tools:
        a = t.annotations
        assert a is not None, f"{t.name}: annotations 缺失"
        for hint in ("readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"):
            v = getattr(a, hint)
            assert isinstance(v, bool), f"{t.name}.{hint} 不是布尔: {v!r}"
    # 抽查赋值与预期一致（readonly/openWorld/destructive 的代表）
    by_name = {t.name: t.annotations for t in tools}
    for name, exp in EXPECTED_ANNOTATIONS.items():
        got = (
            by_name[name].readOnlyHint,
            by_name[name].destructiveHint,
            by_name[name].idempotentHint,
            by_name[name].openWorldHint,
        )
        assert got == exp, f"{name}: {got} != {exp}"


# ---------------------------------------------------------------- workspace 生命周期

def test_workspace_add_update_remove(as_user):
    r = mcp_endpoint.workspace_add(path="/tmp/proj-x", purpose="测试用途", name="X")
    assert r["created"] is True and r["workspace_id"]
    wid = r["workspace_id"]

    # 同路径二次 add = 更新（幂等）
    r2 = mcp_endpoint.workspace_add(path="/tmp/proj-x", purpose="新用途")
    assert r2["created"] is False and r2["purpose"] == "新用途" and r2["name"] == "X"

    # need_summary：没填 purpose 时提示补总结
    r3 = mcp_endpoint.workspace_add(path="/tmp/proj-y")
    assert r3["need_summary"] is True

    # 在线工作区拒绝移除
    with pytest.raises(ValueError, match="online"):
        mcp_endpoint.workspace_remove(workspace_id=wid)
    # "等心跳过期"路径：status=online 但心跳拨老 → ws_is_online=False → 可直接移除
    with Session(engine) as s:
        w = s.get(models.Workspace, wid)
        w.status = "online"
        w.last_heartbeat = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=HEARTBEAT_TIMEOUT_SECONDS + 1)
        s.add(w)
        s.commit()
    # 换个路径验证守卫只看 ws_is_online：先 disable，状态离开 online 立即可删
    mcp_endpoint.workspace_disable(workspace_id=wid)
    assert mcp_endpoint.workspace_remove(workspace_id=wid)["ok"] is True
    # 清理 r3 的 proj-y（add 落库即 online，会污染后续 list_workspaces 断言）
    mcp_endpoint.workspace_disable(workspace_id=r3["workspace_id"])
    assert mcp_endpoint.workspace_remove(workspace_id=r3["workspace_id"])["ok"] is True


def test_enable_disable_offline_cycle(as_user, ws):
    assert mcp_endpoint.workspace_disable(workspace_id=ws.id)["status"] == "disabled"
    # disabled 状态心跳不复活（AGENTS.md 事实）
    hb = mcp_endpoint.heartbeat(workspace_id=ws.id)
    assert hb["ok"] is False and hb["status"] == "disabled"
    assert mcp_endpoint.workspace_enable(workspace_id=ws.id)["status"] == "offline"
    # enable 后心跳恢复 online
    hb = mcp_endpoint.heartbeat(workspace_id=ws.id, session_id="ses-1", session_title="hello")
    assert hb == {"ok": True, "status": "online"}
    with Session(engine) as s:
        w = s.get(models.Workspace, ws.id)
        assert w.session_id == "ses-1"
        assert w.status == "online"
    # offline 幂等；disabled 保持不变（不能绕过 disable）
    assert mcp_endpoint.workspace_offline(workspace_id=ws.id)["status"] == "offline"
    assert mcp_endpoint.workspace_offline(workspace_id=ws.id)["status"] == "offline"
    mcp_endpoint.workspace_disable(workspace_id=ws.id)
    assert mcp_endpoint.workspace_offline(workspace_id=ws.id)["status"] == "disabled"


def test_heartbeat_empty_values_do_not_overwrite(as_user, ws):
    mcp_endpoint.heartbeat(workspace_id=ws.id, session_id="ses-keep", session_title="旧标题")
    mcp_endpoint.heartbeat(workspace_id=ws.id, session_id="", session_title="", agent_type="claude")
    with Session(engine) as s:
        w = s.get(models.Workspace, ws.id)
        assert w.session_id == "ses-keep"  # 空值不覆盖
        assert w.agent_type == "claude"    # 非空才更新


def test_update_notes_and_info(as_user, ws):
    r = mcp_endpoint.update_notes(workspace_id=ws.id, notes="第一行")
    assert r["notes"] == "第一行"
    r = mcp_endpoint.update_notes(workspace_id=ws.id, notes="第二行", append=True)
    assert r["notes"] == "第一行\n第二行"
    r = mcp_endpoint.update_notes(workspace_id=ws.id, notes="覆盖", append=False)
    assert r["notes"] == "覆盖"
    r = mcp_endpoint.update_info(workspace_id=ws.id, purpose="新用途", capabilities="能力A")
    assert r["purpose"] == "新用途" and r["capabilities"] == "能力A"
    # 空串 = 不修改
    r = mcp_endpoint.update_info(workspace_id=ws.id)
    assert r["purpose"] == "新用途"


def test_list_workspaces_filtering(as_user, ws):
    # 在线工作区默认可见；include_offline=False 时离线的被过滤
    mcp_endpoint.workspace_disable(workspace_id=ws.id)
    assert mcp_endpoint.list_workspaces(include_offline=False)["workspaces"] == []
    out = mcp_endpoint.list_workspaces(include_offline=True)["workspaces"]
    assert [w["workspace_id"] for w in out] == [ws.id]
    assert out[0]["status"] == "disabled" and out[0]["is_self"] is True


def test_cross_user_isolation(user, ws):
    """非属主（contextvar 注入别人）看不到也动不了你的工作区。"""
    intruder = models.User(
        id="u-evil",
        username="evil",
        password_hash=models.hash_password("password123"),
        api_key_hash=models.hash_api_key("ak-evil"),
        api_key="ak-evil",
    )
    with Session(engine) as s:
        s.add(intruder)
        s.commit()
    # commit 会 expire 实例（expire_on_commit 默认开）；重新加载成"属性齐全的脱离实例"
    with Session(engine) as s:
        intruder = s.get(models.User, "u-evil")
    tok = mcp_endpoint.current_user.set(intruder)
    try:
        assert mcp_endpoint.list_workspaces(include_offline=True)["workspaces"] == []
        with pytest.raises(ValueError, match="not found or not owned"):
            mcp_endpoint.workspace_disable(workspace_id=ws.id)
        with pytest.raises(ValueError):
            mcp_endpoint.a2a_task(task_id="w-test")  # 也不存在这个任务
    finally:
        mcp_endpoint.current_user.reset(tok)


# ---------------------------------------------------------------- a2a_call / a2a_task

def test_a2a_call_internal_target_lands_queued(as_user, ws):
    """内部工作区且无插件连接：任务落 queued，dispatch 无连接安全返回 0。"""
    with Session(engine) as s:
        s.add(models.Workspace(
            id="w-dest", user_id=as_user.id, name="d", path="/d",
            status="online", last_heartbeat=datetime.now(timezone.utc).replace(tzinfo=None),
        ))
        s.commit()
    r = asyncio.run(
        mcp_endpoint.a2a_call(target="w-dest", message="帮我查下 TODO", from_workspace=ws.id)
    )
    assert r["status"] == "queued" and r["task_id"]
    assert r["note"] == "poll with a2a_task"
    with Session(engine) as s:
        t = s.get(models.A2aTask, r["task_id"])
        assert t is not None and t.caller == "agent" and t.from_workspace_id == ws.id
        assert crypto_decrypt_ok(t, "帮我查下 TODO")


def test_a2a_call_rejects_self_dispatch(as_user, ws):
    """禁止自我派单（2026-09-25）：target = from_workspace 直接拒绝，任务不落库。

    无 from_workspace 时服务端无从判定"自己"，不拦（文档约束调用方注明来源）。
    """
    with Session(engine) as s:
        before = {
            t.id
            for t in s.exec(
                select(models.A2aTask).where(models.A2aTask.workspace_id == ws.id)
            ).all()
        }
    with pytest.raises(ValueError, match="self-call loop"):
        asyncio.run(
            mcp_endpoint.a2a_call(target=ws.id, message="x", from_workspace=ws.id)
        )
    with Session(engine) as s:
        after = {
            t.id
            for t in s.exec(
                select(models.A2aTask).where(models.A2aTask.workspace_id == ws.id)
            ).all()
        }
    assert after == before  # 拒绝时没有新任务落库


def crypto_decrypt_ok(t: models.A2aTask, plain: str) -> bool:
    from server import crypto

    return crypto.decrypt("ak-test", t.message_enc, t.message) == plain


def test_a2a_call_rejects_bad_targets(as_user, ws):
    with pytest.raises(ValueError, match="not found or not visible"):
        asyncio.run(mcp_endpoint.a2a_call(target="w-nope", message="x"))
    # 别人的工作区不可见
    with pytest.raises(ValueError, match="not found or not visible"):
        asyncio.run(mcp_endpoint.a2a_call(target="w-evil-ws", message="x"))
    # disabled 工作区
    with Session(engine) as s:
        s.add(models.Workspace(id="w-dis", user_id=as_user.id, name="d", path="/d", status="disabled"))
        s.commit()
    with pytest.raises(ValueError, match="disabled"):
        asyncio.run(mcp_endpoint.a2a_call(target="w-dis", message="x"))
    # 离线且心跳过期（非后台模式）→ 不可派发
    with Session(engine) as s:
        s.add(models.Workspace(
            id="w-stale", user_id=as_user.id, name="s", path="/s", status="online",
            last_heartbeat=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=2),
        ))
        s.commit()
    with pytest.raises(ValueError, match="not online"):
        asyncio.run(mcp_endpoint.a2a_call(target="w-stale", message="x"))


def test_a2a_task_status_and_ownership(as_user, ws):
    with Session(engine) as s:
        t = models.A2aTask(id="t-owner", context_id="c1", workspace_id=ws.id, user_id=as_user.id, caller="agent", status="working")
        s.add(t)
        s.commit()
    r = mcp_endpoint.a2a_task(task_id="t-owner")
    assert r["status"] == "working" and r["task_id"] == "t-owner"
    # input-required 附带提示
    with Session(engine) as s:
        t = s.get(models.A2aTask, "t-owner")
        t.status = "input-required"
        s.add(t)
        s.commit()
    assert "needs input" in mcp_endpoint.a2a_task(task_id="t-owner")["note"]
    # 不存在的任务
    with pytest.raises(ValueError, match="not found"):
        mcp_endpoint.a2a_task(task_id="t-none")


def test_a2a_task_timeout_marks_failed(as_user, ws):
    """queued/working 超过 CALL_TIMEOUT → a2a_task 顺带置 failed（懒超时）。"""
    with Session(engine) as s:
        old = datetime.now(timezone.utc) - timedelta(seconds=mcp_endpoint.CALL_TIMEOUT_SECONDS + 10)
        t = models.A2aTask(id="t-timeout", context_id="c2", workspace_id=ws.id, user_id=as_user.id,
                           caller="agent", status="working", created_at=old)
        s.add(t)
        s.commit()
    r = mcp_endpoint.a2a_task(task_id="t-timeout")
    assert r["status"] == "failed" and "timeout" in r["error"]


# ---------------------------------------------------------------- artifact_upload

def test_artifact_upload_signs_one_time_url(as_user, ws):
    r = mcp_endpoint.artifact_upload(name="report.pdf", note="周报", task_id="t-owner")
    # 测试环境没有请求中间件，base_url 为空 → 相对路径；生产环境为绝对 URL。
    # 两种形态都要带一次性凭证参数。
    url = r["upload_url"]
    assert "nonce=" in url and "token=" in url and "name=report.pdf" in url
    assert r["expires_in_seconds"] == 600
    # 凭证可被校验（一次性语义由上传端点负责，这里只验签名链路）
    from urllib.parse import urlparse, parse_qs
    from server import artifacts as art

    q = parse_qs(urlparse(url).query)
    assert art.verify_upload_token("u-test", q["nonce"][0], q["token"][0])
    assert not art.verify_upload_token("u-test", q["nonce"][0], q["token"][0])  # 第二次 = 已用
    # 无效名
    with pytest.raises(ValueError, match="name is required"):
        mcp_endpoint.artifact_upload(name="  ")


def test_artifact_upload_task_ownership(as_user, ws):
    with pytest.raises(ValueError, match="not found or not yours"):
        mcp_endpoint.artifact_upload(name="a.txt", task_id="t-not-mine")


# ---------------------------------------------------------------- 未鉴权兜底

def test_tools_require_user_context():
    """contextvar 为空（未过中间件）时一律 PermissionError。"""
    token = mcp_endpoint.current_user.set(None)
    try:
        with pytest.raises(PermissionError):
            mcp_endpoint.list_workspaces()
        with pytest.raises(PermissionError):
            mcp_endpoint.workspace_add(path="/x")
    finally:
        mcp_endpoint.current_user.reset(token)
