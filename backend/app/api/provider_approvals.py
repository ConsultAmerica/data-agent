"""Provider approvals — which external provider may process which data
class (app/recognition/policy.py). Admin only (`admin.providers`); every
grant and revocation records the actor. Approvals are revoked, never
deleted, so the history of what was allowed stays."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import ActorContext, require_permission
from app.database.dependencies import get_database
from app.models.provider_approval import ProviderApproval
from app.staging.profile import DataClass

router = APIRouter()

# "unclassified" covers documents not yet classified (e.g. OCR at upload).
ApprovableClass = DataClass | Literal["unclassified"]


class ProviderApprovalCreate(BaseModel):
    provider_id: str = Field(min_length=1, max_length=40)
    data_class: ApprovableClass
    purpose: str = Field(min_length=3, max_length=2000)
    region: str | None = Field(default=None, max_length=40)
    expires_at: datetime | None = None


class ProviderApprovalResponse(BaseModel):
    id: int
    provider_id: str
    data_class: str
    purpose: str
    region: str | None
    approved_by: str
    approved_at: datetime
    expires_at: datetime | None
    revoked_by: str | None
    revoked_at: datetime | None

    model_config = {"from_attributes": True}


@router.get("", response_model=list[ProviderApprovalResponse])
async def list_provider_approvals(
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("admin.providers")),
) -> list[ProviderApproval]:
    return list(database.scalars(select(ProviderApproval).order_by(ProviderApproval.id.desc())))


@router.post("", response_model=ProviderApprovalResponse, status_code=201)
async def create_provider_approval(
    payload: ProviderApprovalCreate,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("admin.providers")),
) -> ProviderApproval:
    if payload.expires_at is not None and payload.expires_at <= datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="expires_at must be in the future.")
    approval = ProviderApproval(
        provider_id=payload.provider_id.strip().lower(),
        data_class=payload.data_class,
        purpose=payload.purpose.strip(),
        region=payload.region,
        approved_by=actor.id,
        expires_at=payload.expires_at,
    )
    database.add(approval)
    database.commit()
    database.refresh(approval)
    return approval


@router.post("/{approval_id}/revoke", response_model=ProviderApprovalResponse)
async def revoke_provider_approval(
    approval_id: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("admin.providers")),
) -> ProviderApproval:
    approval = database.get(ProviderApproval, approval_id)
    if approval is None:
        raise HTTPException(status_code=404, detail="Approval not found.")
    if approval.revoked_at is None:
        approval.revoked_at = datetime.now(timezone.utc)
        approval.revoked_by = actor.id
        database.commit()
        database.refresh(approval)
    return approval
