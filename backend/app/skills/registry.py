"""Looking up skills, and recording each version the first time it is used
(DocumentSkillVersion) so results stay traceable to their definition."""

from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.skills.definitions import SKILLS, Skill

logger = logging.getLogger(__name__)

_BY_FAMILY: dict[str, Skill] = {family: skill for skill in SKILLS for family in skill.families}
_BY_ID: dict[str, Skill] = {skill.skill_id: skill for skill in SKILLS}


def skill_for_family(family: str | None) -> Skill | None:
    return _BY_FAMILY.get(family or "")


def get_skill(skill_id: str) -> Skill | None:
    return _BY_ID.get(skill_id)


def record_skill_versions(database: Session) -> None:
    """Store each skill version once. A stored version whose content differs
    from the code means a definition changed without a new version."""

    from app.models.document_skill_version import DocumentSkillVersion

    stored = {
        (row.skill_id, row.version): row.content_hash
        for row in database.scalars(select(DocumentSkillVersion))
    }
    added = False
    for skill in SKILLS:
        known = stored.get((skill.skill_id, skill.version))
        if known is None:
            database.add(DocumentSkillVersion(
                skill_id=skill.skill_id, version=skill.version, content_hash=skill.content_hash(),
                definition=skill.as_dict(),
            ))
            added = True
        elif known != skill.content_hash():
            # The stored definition stays the record; tests pin each hash.
            logger.warning("Skill %s %s changed without a new version", skill.skill_id, skill.version)
    if added:
        database.commit()
