"""Identifiers never reach the logs in full (DI-02, B-016).

All identifiers below are synthetic test values.
"""

from __future__ import annotations

import logging
from uuid import uuid4

import fitz
import pytest
from fastapi.testclient import TestClient

from app.core.masking import mask_identifier, redact_text
from app.main import app

client = TestClient(app)

ACCOUNT = "004417920355"
SSN = "078-05-1120"
IBAN = "GB82 WEST 1234 5698 7654 32"
MRZ = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<"


@pytest.mark.parametrize("secret", [ACCOUNT, SSN, IBAN, MRZ, "4111 1111 1111 1111"])
def test_redact_text_masks_identifier_shapes(secret: str) -> None:
    redacted = redact_text(f"value={secret} end")
    assert secret not in redacted
    assert redacted.endswith(" end")


@pytest.mark.parametrize(
    "harmless",
    [
        "document 3e20108b-720f-403a-aae4-3d64feab8f60",
        "at 2026-10-26 14:25:24",
        "page 12 of 288, 1234 ms",
        "amount 123456789.50",
    ],
)
def test_redact_text_leaves_ordinary_log_content(harmless: str) -> None:
    assert redact_text(harmless) == harmless


def test_mask_identifier_keeps_only_the_tail() -> None:
    assert mask_identifier("123456789") == "*****6789"
    assert mask_identifier("12") == "**"
    assert mask_identifier("") == ""


def test_every_log_record_is_redacted(caplog) -> None:
    with caplog.at_level(logging.INFO):
        logging.getLogger("app.anything").info("account %s on file", ACCOUNT)
    assert ACCOUNT not in caplog.text
    assert "*****0355" in caplog.text


def test_processing_a_document_never_logs_its_identifiers(caplog) -> None:
    pdf = fitz.open()
    page = pdf.new_page()
    for i, line in enumerate(
        [
            f"Invoice Number: LEAK-{uuid4().hex[:6]}",
            f"Bank account: {ACCOUNT}",
            f"Employee SSN: {SSN}",
            f"IBAN: {IBAN}",
            MRZ,
        ]
    ):
        page.insert_text((72, 72 + 18 * i), line, fontsize=10)
    content = pdf.tobytes()
    pdf.close()

    with caplog.at_level(logging.DEBUG):
        upload = client.post(
            "/api/documents/upload",
            files={"file": (f"leak-{uuid4()}.pdf", content, "application/pdf")},
        )
        assert upload.status_code == 201, upload.text
        document_id = upload.json()["document_id"]
        assert client.post(
            f"/api/documents/{document_id}/extract-pages", json={"run_ocr": False}
        ).status_code == 200
        client.post(f"/api/documents/{document_id}/discover-schema")

    for secret in (ACCOUNT, SSN, IBAN, MRZ):
        assert secret not in caplog.text, f"{secret!r} reached the logs"
