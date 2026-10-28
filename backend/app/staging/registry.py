"""Staging profile registry. Profiles register themselves here; nothing
else in the backend or frontend branches on a profile id."""

from __future__ import annotations

from app.staging.profile import StagingProfile

GENERIC_PROFILE_ID = "generic_business_document"

_PROFILES: dict[tuple[str, int], StagingProfile] = {}


def register(profile: StagingProfile) -> StagingProfile:
    key = (profile.profile_id, profile.profile_version)
    if key in _PROFILES and _PROFILES[key] is not profile:
        raise ValueError(f"Staging profile {profile.key} is already registered.")
    _PROFILES[key] = profile
    return profile


def get_profile(profile_id: str, version: int | None = None) -> StagingProfile | None:
    if version is not None:
        return _PROFILES.get((profile_id, version))
    return latest(profile_id)


def latest(profile_id: str) -> StagingProfile | None:
    versions = [p for (pid, _), p in _PROFILES.items() if pid == profile_id]
    return max(versions, key=lambda p: p.profile_version) if versions else None


def latest_profiles() -> list[StagingProfile]:
    """The newest version of every registered profile."""

    return [latest(pid) for pid in sorted({pid for pid, _ in _PROFILES})]


def all_profiles() -> list[StagingProfile]:
    return sorted(_PROFILES.values(), key=lambda p: (p.profile_id, p.profile_version))


def profile_for_family(family: str | None) -> StagingProfile | None:
    """Latest version of the profile registered for a document family."""

    if not family:
        return None
    candidates = [
        p for p in _PROFILES.values() if family in p.document_families
    ]
    if not candidates:
        return None
    # One profile per family is expected; prefer the newest version.
    best_id = max(candidates, key=lambda p: p.profile_version).profile_id
    return latest(best_id)


def generic_profile() -> StagingProfile:
    profile = latest(GENERIC_PROFILE_ID)
    if profile is None:  # pragma: no cover - registered at import
        raise RuntimeError("Generic staging profile is not registered.")
    return profile


def _register_builtin_profiles() -> None:
    from app.staging.profiles.academic_transcript import ACADEMIC_TRANSCRIPT_PROFILE
    from app.staging.profiles.contract_v3 import CONTRACT_V3_PROFILE
    from app.staging.profiles.driving_licence import DRIVING_LICENCE_PROFILE
    from app.staging.profiles.far_part_52 import FAR_PART_52_PROFILE
    from app.staging.profiles.far_regulatory_change import FAR_REGULATORY_CHANGE_PROFILE
    from app.staging.profiles.generic_business_document import GENERIC_PROFILE
    from app.staging.profiles.generic_business_document_v1 import GENERIC_PROFILE_V1
    from app.staging.profiles.invoice_v1 import INVOICE_V1_PROFILE
    from app.staging.profiles.passport import PASSPORT_PROFILE
    from app.staging.profiles.xml_document import XML_DOCUMENT_PROFILE

    register(CONTRACT_V3_PROFILE)
    register(GENERIC_PROFILE_V1)
    register(GENERIC_PROFILE)
    register(INVOICE_V1_PROFILE)
    register(FAR_PART_52_PROFILE)
    register(FAR_REGULATORY_CHANGE_PROFILE)
    register(ACADEMIC_TRANSCRIPT_PROFILE)
    register(XML_DOCUMENT_PROFILE)
    register(PASSPORT_PROFILE)
    register(DRIVING_LICENCE_PROFILE)


_register_builtin_profiles()
