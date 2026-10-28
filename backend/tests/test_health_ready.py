"""Health (liveness) vs ready (dependency) separation + request IDs."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_is_cheap_liveness() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "dataomatix"
    # Must stay lean — no dependency probes on /health.
    assert "checks" not in body
    assert "database" not in body


def test_ready_reports_dependency_checks() -> None:
    response = client.get("/ready")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert "checks" in body
    assert body["checks"]["database"]["status"] == "ok"
    assert "ai" in body
    assert "provider" in body["ai"]


def test_request_id_header_round_trip() -> None:
    response = client.get("/health", headers={"X-Request-ID": "cert-req-123"})
    assert response.headers.get("X-Request-ID") == "cert-req-123"

    generated = client.get("/ready")
    assert generated.headers.get("X-Request-ID")
