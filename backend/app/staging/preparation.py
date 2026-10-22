"""Staging preparation for one extracted document: pin the staging profile,
then build the schema-neutral source structure only if that profile — or
an uncertain resolution — calls for it.

    resolve profile (text + V3 signals; no structure needed)
        → profile.source_structure == "required"        → build structure
        → "optional" and resolution not confident         → build structure
          (the document may really be generic; never skip into an empty
          Generic workbook)
        → otherwise                                        → skip

Anything that needs the structure later (the Generic adapter, the
source-structure endpoints) builds it on demand, so a skip never removes
the capability — it only avoids paying for it up front.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from app.models.document import Document
from app.models.document_staging_workbook import DocumentStagingWorkbook
from app.source_structure.service import (
    build_and_persist_source_structure,
    stored_source_structure_is_current,
)
from app.staging import registry
from app.staging.profile import StagingProfile
from app.staging.resolver import persist_resolution, refine_with_structure, resolve_profile


@dataclass
class StagingPreparation:
    record: DocumentStagingWorkbook
    structure_built: bool
    structure_reason: str
    timings_ms: dict[str, int] = field(default_factory=dict)


def source_structure_needed(profile: StagingProfile, *, confident: bool) -> tuple[bool, str]:
    requirement = profile.source_structure
    if requirement == "required":
        return True, f"{profile.key} requires source structure"
    if not confident:
        return True, "profile resolution was not confident; structure kept for a generic fallback"
    return False, f"{profile.key} declares source structure {requirement}; resolution confident"


def prepare_staging(database: Session, document: Document) -> StagingPreparation:
    started = time.perf_counter()
    resolution = resolve_profile(database, document)
    record = persist_resolution(database, document, resolution)
    resolve_ms = int((time.perf_counter() - started) * 1000)

    needed, reason = source_structure_needed(resolution.profile, confident=resolution.confident)
    structure_ms = 0
    if needed and resolution.confident and stored_source_structure_is_current(database, document):
        # Re-extracting an unchanged document: the stored structure is what a
        # rebuild would produce. (An unconfident resolution still rebuilds —
        # refinement reads the full, uncompacted structure.)
        reason += "; stored structure is current"
    elif needed:
        structure_started = time.perf_counter()
        structure = build_and_persist_source_structure(database, document)
        structure_ms = int((time.perf_counter() - structure_started) * 1000)
        if not resolution.confident:
            # The structure can settle what text signals couldn't (e.g. an
            # invoice titled "Invoice #" with no "invoice number" phrase).
            refined = refine_with_structure(resolution, structure)
            if refined.profile is not resolution.profile:
                record = persist_resolution(database, document, refined)
                reason += f"; structure recognized {refined.profile.key}"

    timings_ms = {"profile_resolution_ms": resolve_ms, "source_structure_ms": structure_ms}
    profile = registry.get_profile(record.profile_id, record.profile_version)
    if profile is not None and profile.materializer is not None:
        # The profile's own domain records (e.g. the canonical FAR model)
        # are built here, once, rather than on first read.
        materialize_started = time.perf_counter()
        profile.materializer(database, document)
        timings_ms["profile_materialize_ms"] = int((time.perf_counter() - materialize_started) * 1000)

    return StagingPreparation(
        record=record,
        structure_built=needed,
        structure_reason=reason,
        timings_ms=timings_ms,
    )
