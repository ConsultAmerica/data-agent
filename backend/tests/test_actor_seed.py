"""Seeded default actors: dev/test only, never usable in production."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException

from app.core.auth import hash_api_key, resolve_actor
from app.core.config import Settings, get_settings
from app.database.session import SessionLocal
from app.models.actor import Actor
from app.services import actor_seed
from app.services.actor_seed import (
    DEFAULT_ACTORS,
    SERVICE_ACTOR_ID,
    ensure_actors_seeded,
)


@pytest.fixture
def production(monkeypatch):
    prod = Settings(app_env="production", seed_service_api_key="leaked-old-key")
    monkeypatch.setattr(actor_seed, "get_settings", lambda: prod)
    yield prod
    monkeypatch.undo()
    database = SessionLocal()
    try:
        ensure_actors_seeded(database)  # restore the test defaults
    finally:
        database.close()


def test_production_never_seeds_defaults() -> None:
    assert Settings(app_env="production").effective_seed_default_actors is False
    assert (
        Settings(app_env="production", seed_default_actors=True).effective_seed_default_actors
        is False
    )
    assert Settings(app_env="development").effective_seed_default_actors is True
    assert (
        Settings(app_env="development", seed_default_actors=False).effective_seed_default_actors
        is False
    )


def test_production_startup_retires_previously_seeded_actors(production) -> None:
    database = SessionLocal()
    try:
        service = database.get(Actor, SERVICE_ACTOR_ID)
        assert service is not None and service.active and service.api_key_hash

        ensure_actors_seeded(database)

        for spec in DEFAULT_ACTORS:
            actor = database.get(Actor, spec["id"])
            database.refresh(actor)
            assert actor.active is False
            assert actor.api_key_hash is None
    finally:
        database.close()


def test_retired_service_key_is_rejected(production, monkeypatch) -> None:
    from app.core import auth

    monkeypatch.setattr(auth, "get_settings", lambda: production)
    bearer = f"Bearer {get_settings().seed_service_api_key}"
    database = SessionLocal()
    try:
        before = resolve_actor(database, actor_id_header=None, authorization=bearer)
        assert before.id == SERVICE_ACTOR_ID

        ensure_actors_seeded(database)

        with pytest.raises(HTTPException) as rejected:
            resolve_actor(database, actor_id_header=None, authorization=bearer)
        assert rejected.value.status_code == 401
    finally:
        database.close()


def test_service_actor_has_no_key_without_configuration(monkeypatch) -> None:
    unset = Settings(app_env="development", seed_service_api_key=None)
    monkeypatch.setattr(actor_seed, "get_settings", lambda: unset)
    database = SessionLocal()
    try:
        ensure_actors_seeded(database)
        service = database.get(Actor, SERVICE_ACTOR_ID)
        database.refresh(service)
        assert service.api_key_hash is None
    finally:
        monkeypatch.undo()
        ensure_actors_seeded(database)
        database.close()


def test_no_api_key_literal_in_actor_seed_source() -> None:
    source = Path(actor_seed.__file__).read_text(encoding="utf-8")
    assert "hash_api_key(\"" not in source
    assert "API_KEY = \"" not in source
    configured = get_settings().seed_service_api_key
    assert configured and hash_api_key(configured) not in source
