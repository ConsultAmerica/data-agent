"""Supplier, site and purchase-order matching for invoices — the
deterministic core of IDR-style recognition.

Supplier: tax id → an approved alias (learned from a reviewer's
correction) → the exact normalized name → one clearly best fuzzy name.
Site: the invoice's supplier / remit-to address against the supplier's
sites. PO: the configured formats, existence in the PO extract, the same
supplier, still open; the business unit comes from the PO, else the site.

Every result says how it was decided. Nothing here changes an extracted
value; it only adds checks (Needs Review) and derived reference values.
"""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass, field

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.reference_data import PurchaseOrder, Supplier, SupplierAlias, SupplierSite

_SUFFIXES = {
    "inc", "incorporated", "llc", "ltd", "limited", "co", "company", "corp", "corporation",
    "plc", "gmbh", "sa", "ag", "bv", "the", "and", "&",
}
FUZZY_MIN = 0.90
FUZZY_MARGIN = 0.05


def normalize_name(name: str | None) -> str:
    tokens = re.sub(r"[^a-z0-9& ]", " ", (name or "").lower()).split()
    return " ".join(t for t in tokens if t not in _SUFFIXES)


def _address_tokens(address: str | None) -> set[str]:
    text = re.sub(r"[^a-z0-9 ]", " ", (address or "").lower())
    return {t for t in text.split() if len(t) > 1 or t.isdigit()}


def _po_box(address: str | None) -> bool:
    return bool(re.search(r"\bp\.?\s*o\.?\s*box\b", (address or "").lower()))


@dataclass
class SupplierMatch:
    status: str  # matched | ambiguous | not_found | excluded | no_master
    supplier: Supplier | None = None
    site: SupplierSite | None = None
    method: str | None = None
    score: float | None = None
    messages: list[str] = field(default_factory=list)
    candidates: list[tuple[Supplier, float]] = field(default_factory=list)


@dataclass
class PoValidation:
    po_number: str | None
    checks: list[tuple[str, str, str]] = field(default_factory=list)  # (check, PASS|REVIEW|INFO, details)
    purchase_order: PurchaseOrder | None = None

    @property
    def failed(self) -> list[str]:
        return [details for _, result, details in self.checks if result == "REVIEW"]


def match_supplier(
    database: Session, *, name: str | None, address: str | None = None, tax_id: str | None = None
) -> SupplierMatch:
    if not database.scalar(select(func.count(Supplier.id))):
        return SupplierMatch("no_master", messages=["No supplier master is loaded; the supplier cannot be confirmed."])
    active = select(Supplier).where(Supplier.active.is_(True))

    match = None
    if tax_id:
        compact = re.sub(r"[^A-Za-z0-9]", "", tax_id).upper()
        for supplier in database.scalars(active.where(Supplier.tax_id.is_not(None))):
            if re.sub(r"[^A-Za-z0-9]", "", supplier.tax_id or "").upper() == compact:
                match = SupplierMatch("matched", supplier, method="tax id", score=1.0)
                break
    normalized = normalize_name(name)
    if match is None and normalized:
        alias = database.scalars(
            select(SupplierAlias).where(SupplierAlias.alias == normalized, SupplierAlias.status == "approved")
        ).first()
        if alias is not None:
            supplier = database.get(Supplier, alias.supplier_id)
            if supplier is not None and supplier.active:
                match = SupplierMatch(
                    "matched", supplier, method="learned alias" if alias.source == "correction" else "alias", score=1.0,
                    messages=[f"Matched through the approved alias '{alias.alias_display}'."],
                )
    suppliers = list(database.scalars(active))
    if match is None and normalized:
        exact = [s for s in suppliers if normalize_name(s.name) == normalized]
        if len(exact) == 1:
            match = SupplierMatch("matched", exact[0], method="exact name", score=1.0)
        elif len(exact) > 1:
            return SupplierMatch("ambiguous", candidates=[(s, 1.0) for s in exact],
                                 messages=[f"{len(exact)} suppliers share the name '{name}'."])
    if match is None and normalized:
        scored = sorted(
            ((s, difflib.SequenceMatcher(None, normalized, normalize_name(s.name)).ratio()) for s in suppliers),
            key=lambda pair: -pair[1],
        )
        best = scored[0] if scored else None
        runner_up = scored[1][1] if len(scored) > 1 else 0.0
        if best and best[1] >= FUZZY_MIN and best[1] - runner_up >= FUZZY_MARGIN:
            match = SupplierMatch(
                "matched", best[0], method="similar name", score=round(best[1], 3),
                messages=[f"Printed '{name}' is close to the master name '{best[0].name}'; confirm."],
            )
        else:
            return SupplierMatch(
                "not_found",
                candidates=[pair for pair in scored[:3] if pair[1] >= 0.5],
                messages=[f"'{name}' is not in the supplier master." if name else "No supplier name was found on the invoice."],
            )
    if match is None:
        return SupplierMatch("not_found", messages=["No supplier name was found on the invoice."])

    if match.supplier.excluded_from_recognition:
        return SupplierMatch(
            "excluded", match.supplier, method=match.method, score=match.score,
            messages=[f"{match.supplier.name} is excluded from automatic recognition (e.g. an internal supplier)."],
        )
    _match_site(database, match, address)
    return match


def _match_site(database: Session, match: SupplierMatch, address: str | None) -> None:
    sites = list(database.scalars(select(SupplierSite).where(SupplierSite.supplier_id == match.supplier.id)))
    if not sites:
        match.messages.append("The supplier has no sites in the master.")
        return
    invoice_tokens = _address_tokens(address)
    if not invoice_tokens:
        if len(sites) == 1:
            match.site = sites[0]
            match.messages.append("No address on the invoice; the supplier's only site is used.")
        else:
            match.messages.append("No address on the invoice to choose between the supplier's sites.")
        return
    scored = sorted(
        ((site, len(invoice_tokens & _address_tokens(site.address)) / max(1, len(_address_tokens(site.address))))
         for site in sites),
        key=lambda pair: -pair[1],
    )
    site, score = scored[0]
    if score >= 0.6:
        match.site = site
        return
    if any(_po_box(s.address) != _po_box(address) for s in sites):
        match.messages.append(
            "The invoice address and the supplier site record differ (one is a PO Box, the other a street "
            "address). Align the site record with what invoices print so the site can be recognized."
        )
    else:
        match.messages.append(f"The invoice address does not match any of the supplier's {len(sites)} site(s).")


def _po_formats() -> list[re.Pattern]:
    raw = get_settings().invoice_po_formats or ""
    return [re.compile(part.strip()) for part in raw.split(";;") if part.strip()]


def validate_po(database: Session, po_number: str | None, supplier: Supplier | None) -> PoValidation:
    result = PoValidation(po_number)
    if not po_number:
        result.checks.append(("PO number", "INFO", "No PO number on the invoice (a non-PO invoice)."))
        return result
    formats = _po_formats()
    if formats:
        if any(p.fullmatch(po_number.strip()) for p in formats):
            result.checks.append(("PO format", "PASS", "Matches a configured PO format."))
        else:
            result.checks.append(("PO format", "REVIEW", f"'{po_number}' does not match the configured PO format(s)."))
    else:
        result.checks.append(("PO format", "INFO", "No PO format is configured (INVOICE_PO_FORMATS)."))
    if not database.scalar(select(func.count(PurchaseOrder.id))):
        result.checks.append(("PO exists", "INFO", "No purchase orders are loaded; existence is not checked."))
        return result
    po = database.scalars(select(PurchaseOrder).where(func.upper(PurchaseOrder.po_number) == po_number.strip().upper())).first()
    if po is None:
        result.checks.append(("PO exists", "REVIEW", f"PO {po_number} is not in the purchase order extract."))
        return result
    result.purchase_order = po
    result.checks.append(("PO exists", "PASS", f"PO {po.po_number} found."))
    if supplier is not None and po.supplier_id is not None:
        if po.supplier_id == supplier.id:
            result.checks.append(("PO supplier", "PASS", "The PO belongs to the invoice's supplier."))
        else:
            other = database.get(Supplier, po.supplier_id)
            result.checks.append(("PO supplier", "REVIEW", f"PO {po.po_number} belongs to {other.name if other else 'another supplier'}."))
    if po.status != "open":
        result.checks.append(("PO status", "REVIEW", f"PO {po.po_number} is {po.status}."))
    else:
        result.checks.append(("PO status", "PASS", "The PO is open."))
    return result


def learn_supplier_alias(database: Session, *, printed_name: str, supplier: Supplier, actor_id: str,
                         document_id: str | None) -> SupplierAlias | None:
    """Record that a printed name means this supplier (a reviewer's
    correction). Later invoices printing the same name match through it."""

    normalized = normalize_name(printed_name)
    if not normalized or normalized == normalize_name(supplier.name):
        return None
    existing = database.scalars(
        select(SupplierAlias).where(SupplierAlias.alias == normalized, SupplierAlias.status == "approved")
    ).first()
    if existing is not None:
        if existing.supplier_id == supplier.id:
            return existing
        existing.status, existing.retired_by = "retired", actor_id
        from datetime import datetime, timezone

        existing.retired_at = datetime.now(timezone.utc)
    alias = SupplierAlias(
        supplier_id=supplier.id, alias=normalized, alias_display=printed_name.strip()[:240],
        source="correction", source_document_id=document_id, created_by=actor_id,
    )
    database.add(alias)
    return alias
