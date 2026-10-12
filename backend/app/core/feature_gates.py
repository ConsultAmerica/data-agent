"""Fail-closed feature gates for restricted releases."""

from __future__ import annotations

from fastapi import HTTPException

from app.core.config import get_settings

_REVIEW_MUTATIONS_DISABLED_DETAIL = (
    "Metadata review mutations are disabled for this release."
)


def require_metadata_review_mutations_enabled() -> None:
    """Block Accept/Edit/Reject and equivalent mutation routes when gated off.

    Used by the RC2 restricted core-platform release so isolation does not
    depend on frontend controls or RBAC role composition alone.
    """

    if get_settings().effective_metadata_review_mutations_enabled:
        return
    raise HTTPException(
        status_code=403,
        detail=_REVIEW_MUTATIONS_DISABLED_DETAIL,
    )
