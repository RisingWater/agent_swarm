"""规划器人工待办 → 桌宠/外部 WS 订阅者（协议 §7.4）。

`planner_channel` 登记待办（action=pending）时，向订阅该 planner 工作区的 `/ws/nexus`
客户端推一条**只读**事件：

    {"type":"planner","payload":{
        "kind":"plan_approval"|"task_acceptance",
        "workspace_id":<wid>, "goal_id":..., "task_id":...,
        "title":..., "detail":..., "updated_at":"<平台收到时间 ISO>"}}

不新增端点；属主过滤由 `nexus_a2a._push_web` 内部的 `_owns` 保证（含通配 "*" 订阅，
不跨用户）。action=resolved 不额外收尾（桌宠只展示提醒，无需撤回/按钮）。
"""
import logging

from server import planner_channel
from server.nexus_a2a import _push_web

log = logging.getLogger("planner.pet")


async def _on_pending(workspace_id: str, action: str, item: dict) -> None:
    if action != "pending":
        return  # 只读提醒：resolved 不推
    payload = {
        "kind": item.get("kind"),
        "workspace_id": workspace_id,
        "goal_id": item.get("goal_id") or "",
        "task_id": item.get("task_id") or "",
        "title": item.get("title") or "",
        "detail": item.get("detail") or "",
        "updated_at": item.get("received_at") or item.get("created_at") or "",
    }
    await _push_web(workspace_id, payload, "planner")
    log.info("planner pet 提醒已推送 wid=%s kind=%s", workspace_id, payload["kind"])


def bind_listener() -> None:
    planner_channel.register_pending_listener(_on_pending)


def unbind_listener() -> None:
    planner_channel.unregister_pending_listener(_on_pending)
