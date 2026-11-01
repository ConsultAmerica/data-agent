"""Oracle metadata discovery: a target object's attributes read from an
Oracle metadata API instead of an uploaded template.

Supported interface: the Oracle Fusion REST resource ``describe``
(``GET {base}/{root}/resources/{version}/{resource}/describe``), read-only,
with the account in settings. It returns the resource's attributes (name,
title, type, mandatory, precision, maxLength), its child resources and
lists of values. Other Oracle interfaces (Import Management's own object
catalog, FBDI control files) are not called: their objects are registered
from their official templates instead.

Nothing is discovered unless an Oracle environment is configured
(``oracle_base_url`` other than the example host, and both
``oracle_metadata_username`` / ``oracle_metadata_password``). The
credentials stay on the server: they're never returned, logged or stored
with a template. A discovered object is registered as a Draft target; an
administrator verifies it like any other.
"""

from __future__ import annotations

import base64
import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Protocol
from urllib.parse import urlparse

from app.core.config import Settings

_RESOURCE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,80}$")
_EXAMPLE_HOST = "example.fa.oraclecloud.com"
_TIMEOUT_SECONDS = 20
_MAX_BYTES = 5 * 1024 * 1024
_TYPES = {
    "string": "string", "integer": "number", "number": "number", "bigdecimal": "number", "decimal": "number",
    "date": "date", "datetime": "datetime", "timestamp": "datetime", "boolean": "boolean",
}


class DiscoveryError(Exception):
    """Discovery is unavailable or the Oracle response can't be used."""


@dataclass
class DiscoveredAttribute:
    name: str
    title: str | None
    data_type: str | None
    required: bool | None
    max_length: int | None = None
    precision: int | None = None
    scale: int | None = None
    description: str | None = None
    has_lookup: bool = False


@dataclass
class DiscoveredObject:
    resource: str
    title: str | None
    attributes: list[DiscoveredAttribute]
    children: list[str] = field(default_factory=list)
    raw: bytes = b""


class MetadataProvider(Protocol):
    name: str
    configured: bool
    message: str

    def describe(self, resource: str) -> DiscoveredObject: ...


class NotConfigured:
    name = "none"
    configured = False
    message = (
        "No Oracle environment is configured for metadata discovery. Register targets from official "
        "Oracle templates instead."
    )

    def describe(self, resource: str) -> DiscoveredObject:
        raise DiscoveryError(self.message)


def _number(value: Any) -> int | None:
    try:
        return int(str(value)) if value not in (None, "") else None
    except ValueError:
        return None


def parse_describe(payload: dict, resource: str) -> DiscoveredObject:
    """The attributes of one resource from a describe response. Shapes not
    recognised raise, rather than yield a partial schema."""

    resources = payload.get("Resources") if isinstance(payload, dict) else None
    if not isinstance(resources, dict) or not resources:
        raise DiscoveryError("The describe response has no Resources.")
    body = resources.get(resource) or next(iter(resources.values()))
    attributes = body.get("attributes") if isinstance(body, dict) else None
    if not isinstance(attributes, list) or not attributes:
        raise DiscoveryError("The describe response lists no attributes.")
    found = []
    for item in attributes:
        if not isinstance(item, dict) or not item.get("name"):
            continue
        kind = str(item.get("type") or "").lower()
        data_type = _TYPES.get(kind, "string" if kind else None)
        precision = _number(item.get("precision"))
        max_length = _number(item.get("maxLength"))
        found.append(DiscoveredAttribute(
            name=str(item["name"]),
            title=item.get("title"),
            data_type=data_type,
            required=bool(item["mandatory"]) if "mandatory" in item else None,
            max_length=max_length if data_type == "string" else None,
            precision=precision if data_type == "number" else None,
            scale=_number(item.get("scale")) if data_type == "number" else None,
            description=(item.get("annotations") or {}).get("description") if isinstance(item.get("annotations"), dict) else None,
            has_lookup=bool(item.get("lov")),
        ))
    if not found:
        raise DiscoveryError("The describe response lists no attributes.")
    children = sorted((body.get("children") or {}).keys()) if isinstance(body.get("children"), dict) else []
    return DiscoveredObject(resource=resource, title=body.get("title"), attributes=found, children=children)


class FusionRestDescribe:
    name = "fusion_rest_describe"
    configured = True

    def __init__(self, base_url: str, root: str, version: str, username: str, password: str) -> None:
        self._base = base_url.rstrip("/")
        self._root = root.strip("/")
        self._version = version
        self._auth = "Basic " + base64.b64encode(f"{username}:{password}".encode()).decode()
        self.message = f"Oracle REST metadata at {urlparse(self._base).netloc} ({self._root}, {self._version})."

    def describe(self, resource: str) -> DiscoveredObject:
        if not _RESOURCE.fullmatch(resource or ""):
            raise DiscoveryError("A resource name is letters, digits and underscores (e.g. contracts).")
        url = f"{self._base}/{self._root}/resources/{self._version}/{resource}/describe"
        request = urllib.request.Request(url, headers={"Authorization": self._auth, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=_TIMEOUT_SECONDS) as response:  # noqa: S310 - https only
                raw = response.read(_MAX_BYTES + 1)
        except urllib.error.HTTPError as exc:
            raise DiscoveryError(f"Oracle answered {exc.code} for {resource}.") from None
        except (urllib.error.URLError, TimeoutError) as exc:
            raise DiscoveryError(f"Oracle could not be reached ({getattr(exc, 'reason', exc)}).") from None
        if len(raw) > _MAX_BYTES:
            raise DiscoveryError("The describe response is too large.")
        try:
            payload = json.loads(raw)
        except ValueError:
            raise DiscoveryError("The describe response is not JSON.") from None
        found = parse_describe(payload, resource)
        found.raw = raw
        return found


def provider(settings: Settings) -> MetadataProvider:
    """The configured provider, or NotConfigured."""

    base = (settings.oracle_base_url or "").strip()
    parsed = urlparse(base)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.netloc.lower() == _EXAMPLE_HOST
        or not settings.oracle_metadata_username
        or not settings.oracle_metadata_password
    ):
        return NotConfigured()
    return FusionRestDescribe(
        base, settings.oracle_metadata_rest_root or "fscmRestApi", settings.oracle_api_version,
        settings.oracle_metadata_username, settings.oracle_metadata_password,
    )


def template_columns(found: DiscoveredObject) -> list[dict]:
    """The discovered attributes as template columns, in Oracle's order."""

    columns = []
    for position, attribute in enumerate(found.attributes):
        column: dict = {
            "position": position,
            "technical_name": attribute.name,
            "display_label": attribute.title,
            "required": attribute.required,
        }
        for key in ("data_type", "max_length", "precision", "scale", "description"):
            value = getattr(attribute, key)
            if value is not None:
                column[key] = value
        if attribute.has_lookup:
            column["lookup_type"] = "list of values"
        columns.append(column)
    return columns
