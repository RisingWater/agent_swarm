"""团队与工作区共享的服务层：访问控制 + 数量限制。

核心原则（见 docs/team_requirement.md）：
  **共享 = 授予"调用权"，不授予"可见权"**。
本模块只提供 can_invoke / shared_workspace_ids 这类"能否对其发起 a2a_call"的判定；
监控订阅、Nexus、产物、调用记录列表仍以 `workspace.user_id == user.id` 为唯一门槛——
**禁止**把团队共享并入 `server/api/workspaces.py:visible_workspace_ids` 或
`server/nexus_a2a.py:_owns`，否则会连带泄漏监控与调用细节。
"""
from __future__ import annotations

from sqlmodel import Session, select

from server import models
from server.config import get_int
from server.db import engine  # noqa: F401  （保持与其他服务模块一致的导入习惯）


class TeamError(Exception):
    """团队操作业务错误：API 层转换为 HTTPException(status, message)。"""

    def __init__(self, message: str, status: int = 409):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------- 数量限制
# env 优先 → 根 .env → 默认值；全部非负。


def max_owned_teams() -> int:
    return max(0, get_int("AGENT_SWARM_TEAM_MAX_OWNED", 3))


def max_joined_teams() -> int:
    return max(0, get_int("AGENT_SWARM_TEAM_MAX_JOINED", 8))


def max_team_members() -> int:
    return max(0, get_int("AGENT_SWARM_TEAM_MAX_MEMBERS", 50))


def max_pending_memberships() -> int:
    return max(0, get_int("AGENT_SWARM_TEAM_MAX_PENDING", 10))


# ---------------------------------------------------------------- 查询


def active_team_ids(session: Session, user_id: str) -> set[str]:
    """我当前活跃加入的全部团队 id。"""
    rows = session.exec(
        select(models.TeamMember.team_id)
        .where(models.TeamMember.user_id == user_id)
        .where(models.TeamMember.status == "active")
    ).all()
    return set(rows)


def owned_team_count(session: Session, user_id: str) -> int:
    """我作为队长（owner_id）创建的团队数。"""
    return len(
        session.exec(select(models.Team.id).where(models.Team.owner_id == user_id)).all()
    )


def joined_team_count(session: Session, user_id: str) -> int:
    """我活跃加入的团队总数（含自己创建的团队）。"""
    return len(
        session.exec(
            select(models.TeamMember.id)
            .where(models.TeamMember.user_id == user_id)
            .where(models.TeamMember.status == "active")
        ).all()
    )


def pending_count(session: Session, user_id: str) -> int:
    """我同时挂起的待处理邀请/申请条数（作为受邀方或申请方都算，防刷）。"""
    return len(
        session.exec(
            select(models.TeamMember.id)
            .where(models.TeamMember.user_id == user_id)
            .where(models.TeamMember.status == "pending")
        ).all()
    )


def team_member_count(session: Session, team_id: str, status: str = "active") -> int:
    return len(
        session.exec(
            select(models.TeamMember.id)
            .where(models.TeamMember.team_id == team_id)
            .where(models.TeamMember.status == status)
        ).all()
    )


def get_membership(
    session: Session, team_id: str, user_id: str
) -> models.TeamMember | None:
    """(team, user) 的成员关系行（任意状态）。"""
    return session.exec(
        select(models.TeamMember)
        .where(models.TeamMember.team_id == team_id)
        .where(models.TeamMember.user_id == user_id)
    ).first()


def is_leader(session: Session, team_id: str, user_id: str) -> bool:
    team = session.get(models.Team, team_id)
    return team is not None and team.owner_id == user_id


def is_active_member(session: Session, team_id: str, user_id: str) -> bool:
    m = get_membership(session, team_id, user_id)
    return m is not None and m.status == "active"


# ---------------------------------------------------------------- 数量限制校验（写前调用）


def assert_can_create_team(session: Session, user_id: str) -> None:
    if owned_team_count(session, user_id) >= max_owned_teams():
        raise TeamError(f"你创建的团队已达上限（{max_owned_teams()}）")


def assert_can_join(session: Session, user_id: str) -> None:
    if joined_team_count(session, user_id) >= max_joined_teams():
        raise TeamError(f"你加入的团队已达上限（{max_joined_teams()}）")


def assert_team_has_room(session: Session, team_id: str) -> None:
    if team_member_count(session, team_id) >= max_team_members():
        raise TeamError(f"团队成员已达上限（{max_team_members()}）")


def assert_can_pend(session: Session, user_id: str) -> None:
    if pending_count(session, user_id) >= max_pending_memberships():
        raise TeamError(f"待处理的团队邀请/申请已达上限（{max_pending_memberships()}）")


# ---------------------------------------------------------------- 工作区共享（调用权）


def shared_workspace_ids(session: Session, user_id: str) -> set[str]:
    """我所在活跃团队被共享给我的工作区 id 集合（仅调用权）。"""
    tids = active_team_ids(session, user_id)
    if not tids:
        return set()
    rows = session.exec(
        select(models.TeamWorkspace.workspace_id).where(
            models.TeamWorkspace.team_id.in_(tids)  # type: ignore[attr-defined]
        )
    ).all()
    return set(rows)


def can_invoke(session: Session, user_id: str, workspace_id: str) -> bool:
    """能否对该工作区发起 a2a_call：自有 **或** 被共享给我所在的活跃团队。

    注意：这不等于"可见"——调用方只能通过 a2a_call/a2a_task 拿到最终答复，
    看不到监控、产物、简报与调用细节。
    """
    ws = session.get(models.Workspace, workspace_id)
    if ws is None:
        return False
    if ws.user_id == user_id:
        return True
    return workspace_id in shared_workspace_ids(session, user_id)
