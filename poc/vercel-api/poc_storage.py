"""Private document storage for the Vercel proof of concept.

On Vercel: a **private** Vercel Blob store (``BLOB_STORE_ID`` + the
project's OIDC token — no credentials in code or env files). Locally and in
tests: a directory. Object names are ``documents/<uuid>.pdf`` — never the
uploaded filename. Files are read back only through the API, after an
access check, or with a short-lived HMAC-signed link.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import time
from pathlib import Path


def object_name(document_id: str, extension: str = "pdf") -> str:
    return f"documents/{document_id}.{extension}"


class LocalStorage:
    def __init__(self, root: str) -> None:
        self.root = Path(root)

    def put(self, name: str, data: bytes, content_type: str) -> str:
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return name

    def get(self, name: str) -> bytes:
        return (self.root / name).read_bytes()


class BlobStorage:
    def put(self, name: str, data: bytes, content_type: str) -> str:
        from vercel.blob.sync import put_blob

        # The id-based name never repeats, so no overwrite and no random
        # suffix: the stored pathname is exactly the one recorded.
        return put_blob(name, bytes(data), access="private", content_type=content_type).pathname

    def get(self, name: str) -> bytes:
        from vercel.blob.sync import get_blob

        return bytes(get_blob(name, access="private").body)


def storage():
    # Linking a store sets BLOB_READ_WRITE_TOKEN (or BLOB_STORE_ID with OIDC).
    if os.environ.get("BLOB_STORE_ID") or os.environ.get("BLOB_READ_WRITE_TOKEN"):
        return BlobStorage()
    return LocalStorage(os.environ.get("POC_LOCAL_STORAGE", "/tmp/dataomatix-poc-storage"))


# --- short-lived signed links (the Python Blob SDK has no signed URLs) ------

LINK_SECONDS = 300


def _key() -> bytes:
    secret = os.environ.get("POC_LINK_SECRET") or os.environ.get("POC_ADMIN_KEY")
    if not secret:
        raise RuntimeError("POC_LINK_SECRET is not set.")
    return secret.encode()


def sign_link(document_id: str, now: float | None = None) -> str:
    expires = int((now or time.time()) + LINK_SECONDS)
    mac = hmac.new(_key(), f"{document_id}:{expires}".encode(), hashlib.sha256).digest()
    return f"{expires}.{base64.urlsafe_b64encode(mac).decode().rstrip('=')}"


def verify_link(document_id: str, token: str, now: float | None = None) -> bool:
    try:
        expires_text, signature = token.split(".", 1)
        expires = int(expires_text)
    except ValueError:
        return False
    if expires < (now or time.time()):
        return False
    mac = hmac.new(_key(), f"{document_id}:{expires}".encode(), hashlib.sha256).digest()
    expected = base64.urlsafe_b64encode(mac).decode().rstrip("=")
    return hmac.compare_digest(expected, signature)
