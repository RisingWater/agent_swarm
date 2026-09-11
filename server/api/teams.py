import shortuuid
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from server import models
from server.auth import get_current_user
from server.db import get_session

router = APIRouter(prefix="/api/teams", tags=["teams"])


class CreateTeamBody(BaseModel):
    name: str


class AddMemberBody(BaseModel):
    username: str


def team_out(t: models.Team, member_count: int = 0) -> dict:
    return {
        "id": t.id,
        "name": t.name,
        "owner_id": t.owner_id,
        "member_count": member_count,
        "created_at": t.created_at.isoformat() + "Z",
    }


def get_team_or_403(team_id: str, user: models.User, session: Session) -> models.Team:
    team = session.get(models.Team, team_id)
    if not team:
        raise HTTPException(404, "team not found")
    is_member = session.exec(
        select(models.TeamMember).where(
            models.TeamMember.team_id == team_id, models.TeamMember.user_id == user.id
        )
    ).first()
    if not is_member and team.owner_id != user.id:
        raise HTTPException(403, "not a member of this team")
    return team


@router.post("", status_code=201)
def create_team(
    body: CreateTeamBody,
    user: models.User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    body.name = body.name.strip()
    if not (2 <= len(body.name) <= 64):
        raise HTTPException(422, "team name must be 2-64 chars")
    exists = session.exec(select(models.Team).where(models.Team.name == body.name)).first()
    if exists:
        raise HTTPException(409, "team name already taken")
    team = models.Team(id=shortuuid.uuid(), name=body.name, owner_id=user.id)
    session.add(team)
    session.add(models.TeamMember(team_id=team.id, user_id=user.id))
    session.commit()
    return team_out(team, 1)


@router.get("")
def my_teams(
    user: models.User = Depends(get_current_user), session: Session = Depends(get_session)
):
    memberships = session.exec(
        select(models.TeamMember).where(models.TeamMember.user_id == user.id)
    ).all()
    teams = []
    for m in memberships:
        team = session.get(models.Team, m.team_id)
        if not team:
            continue
        count = len(
            session.exec(
                select(models.TeamMember).where(models.TeamMember.team_id == team.id)
            ).all()
        )
        teams.append(team_out(team, count))
    return teams


@router.post("/{team_id}/members", status_code=201)
def add_member(
    team_id: str,
    body: AddMemberBody,
    user: models.User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    team = session.get(models.Team, team_id)
    if not team:
        raise HTTPException(404, "team not found")
    if team.owner_id != user.id:
        raise HTTPException(403, "only team owner can add members")
    target = session.exec(
        select(models.User).where(models.User.username == body.username.strip())
    ).first()
    if not target:
        raise HTTPException(404, "user not found")
    exists = session.exec(
        select(models.TeamMember).where(
            models.TeamMember.team_id == team_id, models.TeamMember.user_id == target.id
        )
    ).first()
    if exists:
        raise HTTPException(409, "already a member")
    session.add(models.TeamMember(team_id=team_id, user_id=target.id))
    session.commit()
    return {"ok": True, "added": {"id": target.id, "username": target.username}}


@router.get("/{team_id}/members")
def list_members(
    team_id: str,
    user: models.User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    get_team_or_403(team_id, user, session)
    rows = session.exec(
        select(models.TeamMember).where(models.TeamMember.team_id == team_id)
    ).all()
    members = []
    for r in rows:
        u = session.get(models.User, r.user_id)
        if u:
            members.append(
                {
                    "id": u.id,
                    "username": u.username,
                    "is_owner": u.id == session.get(models.Team, team_id).owner_id,
                }
            )
    return members


@router.delete("/{team_id}/members/{user_id}")
def remove_member(
    team_id: str,
    user_id: str,
    user: models.User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    team = session.get(models.Team, team_id)
    if not team:
        raise HTTPException(404, "team not found")
    if team.owner_id != user.id:
        raise HTTPException(403, "only team owner can remove members")
    if user_id == team.owner_id:
        raise HTTPException(422, "cannot remove team owner")
    row = session.exec(
        select(models.TeamMember).where(
            models.TeamMember.team_id == team_id, models.TeamMember.user_id == user_id
        )
    ).first()
    if not row:
        raise HTTPException(404, "member not found")
    session.delete(row)
    session.commit()
    return {"ok": True}
