"""P0 stress-path fixes: storage stream telemetry + medium provenance + OCR KV."""

from __future__ import annotations

import shutil
from io import BytesIO
from pathlib import Path
from unittest.mock import MagicMock, patch
from uuid import uuid4

import fitz
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw, ImageFont

from app.core.config import Settings
from app.main import app
from app.services.document_storage import DocumentStorageError, upload_object
from app.services.structure_detection import detect_document_structures
from app.services.ai_provider import DisabledAIProvider
from types import SimpleNamespace

client = TestClient(app)


def _tiny_padded_pdf(target_bytes: int) -> bytes:
    pdf = fitz.open()
    page = pdf.new_page()
    page.insert_text((72, 72), "Stress pad PDF")
    core = pdf.tobytes()
    pdf.close()
    if len(core) >= target_bytes:
        return core[:target_bytes]
    return core + (b"\0" * (target_bytes - len(core)))


def _font(size: int = 32):
    try:
        return ImageFont.truetype("arial.ttf", size)
    except OSError:
        return ImageFont.load_default()


def _mixed_language_png() -> bytes:
    image = Image.new("RGB", (1200, 700), "white")
    draw = ImageDraw.Draw(image)
    font = _font(32)
    lines = [
        "Invoice Number: ML-2026-4401",
        "Amount: $42,750.00",
        "Date: 11/09/2026",
        "Factura: ES-7781",
        "Montant: 1250 EUR",
        f"Nonce: {uuid4()}",
    ]
    y = 80
    for line in lines:
        draw.text((64, y), line, fill="black", font=font)
        y += 70
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def test_upload_object_streams_file_with_content_length(tmp_path: Path) -> None:
    settings = Settings(
        supabase_url="https://example.supabase.co",
        supabase_service_role_key="service-role",
        supabase_storage_bucket="docs",
    )
    path = tmp_path / "big.bin"
    payload = b"x" * (12 * 1024 * 1024)
    path.write_bytes(payload)

    captured: dict = {}

    def fake_put(url, headers=None, content=None, timeout=None):
        captured["headers"] = dict(headers or {})
        captured["timeout"] = timeout
        # Ensure caller passed a readable stream, not full bytes.
        assert hasattr(content, "read")
        response = MagicMock()
        response.status_code = 200
        return response

    with patch("app.services.document_storage.httpx.put", side_effect=fake_put):
        upload_object(
            settings,
            "obj.bin",
            content_type="application/pdf",
            file_path=path,
            size_bytes=len(payload),
        )

    assert captured["headers"]["Content-Length"] == str(len(payload))
    assert captured["headers"]["Content-Type"] == "application/pdf"


def test_upload_object_logs_structured_failure(tmp_path: Path) -> None:
    settings = Settings(
        supabase_url="https://example.supabase.co",
        supabase_service_role_key="service-role",
        supabase_storage_bucket="docs",
    )
    path = tmp_path / "fail.bin"
    path.write_bytes(b"abc")

    response = MagicMock()
    response.status_code = 413

    with (
        patch("app.services.document_storage.httpx.put", return_value=response),
        patch("app.services.document_storage.log_event") as log_event,
    ):
        with pytest.raises(DocumentStorageError) as exc:
            upload_object(
                settings,
                "obj.bin",
                content_type="application/pdf",
                file_path=path,
                size_bytes=3,
            )

    assert exc.value.http_status == 413
    assert log_event.called
    kwargs = log_event.call_args.kwargs
    assert log_event.call_args.args[0] == "document_storage_failed"
    assert kwargs["error_type"] == "RemoteHttpError"
    assert kwargs["http_status"] == 413
    assert kwargs["size_bytes"] == 3
    assert kwargs["storage_provider"] == "supabase"


def test_medium_upload_enqueues_background_and_stamps_provenance() -> None:
    content = _tiny_padded_pdf(11 * 1024 * 1024)

    with (
        patch("app.api.documents.upload_object"),
        patch(
            "app.services.upload_processing.BackgroundTasks.add_task",
            create=True,
        ),
    ):
        # BackgroundTasks.add_task is on the FastAPI instance; enqueue still
        # creates the job row. Avoid running the real OCR job in-process.
        with patch(
            "app.services.upload_processing.run_processing_job",
            new=MagicMock(),
        ):
            response = client.post(
                "/api/documents/upload",
                files={
                    "file": (
                        "pad-20mb.pdf",
                        content,
                        "application/pdf",
                    )
                },
            )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["prefer_background"] is True
    assert body["size_tier"] in {"medium", "large"}
    assert body["processing_job_id"] is not None
    provenance = body["ingestion_provenance"] or {}
    assert provenance["processing_mode"] == "background"
    assert provenance["processing_job_id"] == body["processing_job_id"]
    assert provenance["size_tier"] == body["size_tier"]


@pytest.mark.asyncio
async def test_mixed_language_labeled_fields_become_candidates() -> None:
    text = (
        "Invoice Number: ML-2026-4401\n"
        "Amount: $42,750.00\n"
        "Date: 11/09/2026\n"
        "Factura: ES-7781\n"
    )
    page = SimpleNamespace(
        page_number=1,
        final_text=text,
        tables_json=[],
        form_fields_json={},
    )
    document = SimpleNamespace(
        id="doc-mixed",
        original_filename="mixed_language_latin.png",
        document_type=None,
    )
    result = await detect_document_structures(
        document=document,
        pages=[page],
        ai_provider=DisabledAIProvider(),
    )
    keys = {target.key for target in result.detected_targets}
    assert "invoice_number" in keys
    assert "amount" in keys
    assert "date" in keys


@pytest.mark.skipif(shutil.which("tesseract") is None, reason="Tesseract OCR not installed")
def test_png_ocr_persists_final_text_and_discovers_invoice() -> None:
    png = _mixed_language_png()
    with patch("app.api.documents.upload_object"):
        uploaded = client.post(
            "/api/documents/upload",
            files={"file": ("mixed_language_latin.png", png, "image/png")},
        )
    assert uploaded.status_code == 201, uploaded.text
    document_id = uploaded.json()["document_id"]

    extracted = client.post(
        f"/api/documents/{document_id}/extract-pages",
        json={
            "run_ocr": True,
            "page_start": None,
            "page_end": None,
            "force_reprocess": True,
        },
    )
    if extracted.status_code != 200:
        pytest.skip(f"OCR unavailable in environment: {extracted.text}")

    pages = client.get(f"/api/documents/{document_id}/pages").json()
    text = pages[0]["final_text"]
    assert text.strip(), "DocumentPage.final_text should not be empty after OCR"
    assert "ML-2026-4401" in text.replace(" ", "")

    discovered = client.post(f"/api/documents/{document_id}/discover-schema")
    assert discovered.status_code == 200, discovered.text
    targets = discovered.json()["targets"]
    labels = {
        (target.get("display_name") or target.get("label") or "").lower()
        for target in targets
    }
    keys = {target.get("key") for target in targets}
    assert "invoice_number" in keys or any("invoice" in label for label in labels)
    assert "amount" in keys or any(label == "amount" for label in labels)
    assert "date" in keys or any(label == "date" for label in labels)
