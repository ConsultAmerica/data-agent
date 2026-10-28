"""Seed default actors for development and certification tests.

Default actors exist only outside production. The service account's API
key is never in source: it comes from SEED_SERVICE_API_KEY (the test
suite sets its own), and without it the service actor has no key at all.

In production the defaults are never seeded, and any that an earlier
release seeded are retired on startup (deactivated, API key cleared) —
earlier releases shipped a well-known service key that must not keep
working there.
"""

from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from app.core.auth import DEFAULT_DEV_ACTOR_ID, hash_api_key
from app.core.config import get_settings
from app.models.actor import Actor

logger = logging.getLogger(__name__)

SERVICE_ACTOR_ID = "actor-service-default"

DEFAULT_ACTORS: list[dict] = [
    {
        "id": DEFAULT_DEV_ACTOR_ID,
        "actor_type": "user",
        "display_name": "Dev Admin",
        "email": "admin@localhost",
        "role": "admin",
    },
    {
        "id": "actor-reviewer-default",
        "actor_type": "user",
        "display_name": "Default Reviewer",
        "email": "reviewer@localhost",
        "role": "reviewer",
    },
    {
        "id": "actor-analyst-default",
        "actor_type": "user",
        "display_name": "Default Analyst",
        "email": "analyst@localhost",
        "role": "analyst",
    },
    {
        "id": "actor-viewer-default",
        "actor_type": "user",
        "display_name": "Default Viewer",
        "email": "viewer@localhost",
        "role": "viewer",
    },
    {
        "id": SERVICE_ACTOR_ID,
        "actor_type": "service",
        "display_name": "Default Service Account",
        "email": None,
        "role": "service_account",
    },
]


def _service_key_hash() -> str | None:
    key = (get_settings().seed_service_api_key or "").strip()
    return hash_api_key(key) if key else None


def seed_default_actors(database: Session) -> None:
    service_hash = _service_key_hash()
    for spec in DEFAULT_ACTORS:
        key_hash = service_hash if spec["id"] == SERVICE_ACTOR_ID else None
        existing = database.get(Actor, spec["id"])
        if existing is None:
            database.add(Actor(**spec, api_key_hash=key_hash, active=True))
        else:
            # Keep role/display in sync for seeded ids only.
            existing.role = spec["role"]
            existing.display_name = spec["display_name"]
            existing.actor_type = spec["actor_type"]
            existing.email = spec["email"]
            existing.api_key_hash = key_hash
            existing.active = True
    database.commit()


def retire_default_actors(database: Session) -> list[str]:
    """Deactivate seeded defaults and clear their keys. Returns the ids
    that were still usable."""

    retired: list[str] = []
    for spec in DEFAULT_ACTORS:
        existing = database.get(Actor, spec["id"])
        if existing is None:
            continue
        if existing.active or existing.api_key_hash:
            retired.append(spec["id"])
        existing.active = False
        existing.api_key_hash = None
    database.commit()
    return retired


def ensure_actors_seeded(database: Session) -> None:
    if get_settings().effective_seed_default_actors:
        seed_default_actors(database)
        return
    retired = retire_default_actors(database)
    if retired:
        logger.warning(
            "Retired seeded default actors in %s: %s",
            get_settings().app_env,
            ", ".join(retired),
        )
