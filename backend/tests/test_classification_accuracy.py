"""Classification accuracy, measured on its own (not extraction accuracy).

A labelled set of real and synthetic documents: the regression contracts
and FAR files (when present), the invoice fixtures, and generated
passports, driving licences and a transcript. The report prints family and
subtype accuracy and how many documents were sent to review. Scores are
evidence strength, not calibrated probabilities, so no calibration claim
is made or tested here.
"""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app
from demo.synthetic import passport_pdf
from tests.test_academic_transcript import _pdf as transcript_pdf
from tests.test_academic_transcript import _university
from tests.test_driving_licence_profile import eu_licence, us_licence
from tests.test_export_consistency import _process

client = TestClient(app)

ROOT = Path(__file__).resolve().parents[2]
REGRESSION = ROOT / "reference" / "regression"
INVOICES = Path(__file__).resolve().parent / "fixtures" / "invoices"

# (name, bytes factory, expected family, expected subtype or None = not scored)
_FILES: list[tuple[str, Path, str, str | None]] = [
    ("SF1442 Award_N4019223D2803.pdf", REGRESSION / "SF1442 Award_N4019223D2803.pdf", "government_contract", "SF 1442 Contract Award"),
    ("Contract - FA300224C0008 (2).pdf", REGRESSION / "Contract - FA300224C0008 (2).pdf", "government_contract", "SF 33 Solicitation / Award"),
    ("Contract_47QRCA25DSF07 (2).pdf", REGRESSION / "Contract_47QRCA25DSF07 (2).pdf", "government_contract", None),
    ("far_part_51.pdf", REGRESSION / "far_part_51.pdf", "far_regulation", None),
    ("far_final_rule_2026-04912.pdf", REGRESSION / "far_final_rule_2026-04912.pdf", "far_regulatory_change", None),
    *[(p.name, p, "invoice", None) for p in sorted(INVOICES.glob("*.pdf"))],
]
_GENERATED = [
    ("passport.pdf", passport_pdf, "passport", None),
    ("us-licence.pdf", us_licence, "driving_licence", None),
    ("eu-licence.pdf", eu_licence, "driving_licence", None),
    ("transcript.pdf", lambda: transcript_pdf(_university), "academic_transcript", None),
]


def _needs_ocr(path: Path) -> bool:
    return path.name.startswith("f2_scanned")  # a scanned image: no text without Tesseract


def test_classification_accuracy_report(capsys) -> None:
    import shutil

    rows = []
    corpus = [(name, path.read_bytes, family, subtype, _needs_ocr(path)) for name, path, family, subtype in _FILES
              if path.exists()]
    corpus += [(name, factory, family, subtype, False) for name, factory, family, subtype in _GENERATED]
    for name, read, expected, expected_subtype, ocr in corpus:
        if ocr and shutil.which("tesseract") is None:
            continue
        document_id = _process(name, read(), "application/pdf", ocr=ocr)
        state = client.get(f"/api/documents/{document_id}/classification").json()
        rows.append({
            "name": name, "expected": expected, "got": state["family"], "ok": state["family"] == expected,
            "subtype_ok": None if expected_subtype is None else state["subtype"] == expected_subtype,
            "confidence": state["confidence"], "status": state["status"],
        })

    scored = [r for r in rows if r["subtype_ok"] is not None]
    family_accuracy = sum(r["ok"] for r in rows) / len(rows)
    with capsys.disabled():
        print(f"\nClassification accuracy on {len(rows)} labelled documents")
        for r in rows:
            mark = "OK " if r["ok"] else "XX "
            print(f"  {mark}{r['name'][:40]:<40} expected {r['expected']:<22} got {r['got']:<22} "
                  f"{(r['confidence'] or 0):.2f} {r['status']}")
        print(f"  family accuracy {family_accuracy:.0%}; subtype {sum(r['subtype_ok'] for r in scored)}/{len(scored)}; "
              f"sent to review {sum(r['status'] != 'classified' for r in rows)}/{len(rows)}")
    assert family_accuracy == 1.0, [r for r in rows if not r["ok"]]
    assert all(r["subtype_ok"] for r in scored)
