"""站内信：用户可见的事件通知（团队邀请/审批/加入/踢出/移交/解散等）。

纯文本落库（团队名/用户名同属非加密字段）。写侧在团队操作的同一事务里 `add()`，
随操作一起提交；读侧走 `/api/notifications` REST。
"""
from __future__ import annotations

import shortuuid
from sqlmodel import Session

from server import models


def add(
    session: Session,
    *,
    user_id: str,
    kind: str,
    title: str,
    body: str = "",
    team_id: str = "",
    team_name: str = "",
    actor_id: str = "",
    actor_username: str = "",
) -> models.Notification | None:
    """给单个用户写一条站内信（user_id 为空则跳过）。"""
    if not user_id:
        return None
    n = models.Notification(
        id=shortuuid.uuid(),
        user_id=user_id,
        kind=kind,
        title=title[:200],
        body=body[:2000],
        team_id=team_id,
        team_name=team_name[:100],
        actor_id=actor_id,
        actor_username=actor_username[:100],
    )
    session.add(n)
    return n


def add_many(session: Session, user_ids, **kwargs) -> int:
    """给一批用户写同一内容的站内信（去重）。返回写入条数。"""
    n = 0
    for uid in set(x for x in user_ids if x):
        if add(session, user_id=uid, **kwargs):
            n += 1
    return n
