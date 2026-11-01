"""Label recognition: for each extracted value, its printed label, a clean
display label, its item number and its business meaning.

The printed label is never changed: it stays on the record, and the display
label is derived from it.
- A form box's instructions are removed (form_label: "2 Enter the Contract
  Number" → item 2, "Contract Number").
- A technical name is put into words (display_label: "contract_no" →
  "Contract Number").
- An abbreviated spelling is written out from the document type's own
  table ("Invoice No." → "Invoice Number"; "P.O. No." only in invoices and
  purchase orders, never "P.O. Box").
No word that names the field is dropped: "Total Due" stays "Total Due",
and only its meaning (Total) is recorded. A label that can't be put into
words ("Text1") is unresolved, never guessed.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from functools import lru_cache
import json
from pathlib import Path
import re
from typing import Any

from app.document_validation import layout_fields
from app.skills.registry import skill_for_family
from app.skills.values import normalized
from app.source_structure.original_layout import _TECHNICAL_NAME, display_label, form_label
from app.source_structure.text_shapes import normalize_space

_ALIASES_PATH = Path(__file__).with_name("label_aliases.json")
# A form tool's default name for a box: it names nothing.
_GENERIC_NAME = re.compile(
    r"^(?:text|field|check\s*box|checkbox|untitled|undefined|button|combo\s*box|list\s*box|radio\s*button|f)[\s_-]*\d*$",
    re.I,
)
# Wording a form box's description opens with when it is an instruction.
_INSTRUCTION = re.compile(
    r"^\s*(?:\d{1,3}[A-Za-z]?[.)]?\s+)?(?:\(to be completed by[^)]*\)\s*)?(?:please\s+)?"
    r"(?:enter|type|input|provide|insert|fill in|select|choose|specify|indicate|click)\b",
    re.I,
)
# "9." / "15A)" before a printed label; a bare number ("30 Day Notice") is
# part of the label unless the label is a form box's description.
_PRINTED_NUMBER = re.compile(r"^(\d{1,3}[A-Za-z]?)[.)]\s+(?=[A-Za-z(])")
# Words before "No" that make it the answer, not "Number" ("Yes or No").
_NOT_NAMED = {"yes", "yes/", "or", "and", "y/n"}


@dataclass(frozen=True)
class RecognizedLabel:
    printed: str
    display: str
    item_number: str
    # The business field it is, when the document type knows it ("Bill To"
    # → Customer); None when it doesn't, never a guess.
    meaning: str | None
    # form (a form box's description), alias (an abbreviation written out
    # from the type's table), abbreviation (a common one), printed (as it
    # is), technical (a field identifier put into words), missing.
    source: str
    resolved: bool
    is_choice: bool = False

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@lru_cache(maxsize=1)
def _aliases() -> dict[str, Any]:
    return json.loads(_ALIASES_PATH.read_text(encoding="utf-8"))


def label_key(text: str) -> str:
    """A label as the tables match it: lower case, without periods,
    colons or extra spaces ("P.O. No.:" → "p o no")."""

    return re.sub(r"\s+", " ", re.sub(r"[.:]", " ", (text or "").lower())).strip()


@lru_cache(maxsize=64)
def _type_tables(family: str | None) -> tuple[dict[str, str], dict[str, str]]:
    """(spelling → display label, label → meaning) for a document family."""

    spellings: dict[str, str] = {}
    meanings: dict[str, str] = {}
    for entry in _aliases()["types"].values():
        if family not in entry["families"]:
            continue
        for display, variants in entry["labels"].items():
            for variant in variants:
                spellings[label_key(variant)] = display
        for meaning, variants in entry.get("meanings", {}).items():
            meanings[label_key(meaning)] = meaning
            for variant in variants:
                meanings[label_key(variant)] = meaning
    return spellings, meanings


def _expand_common(text: str) -> str:
    """Abbreviations that mean the same in any document: "Acct" → Account,
    and a trailing "No." / "#" after a word → Number ("Acct. No." →
    "Account Number"). "No." anywhere else ("Yes / No") is left as it is."""

    common = _aliases()["common"]
    words = text.split()
    out = []
    for index, word in enumerate(words):
        bare = word.rstrip(".:").lower()
        last = index == len(words) - 1
        if bare in common["abbreviations"] and len(words) <= 6:
            out.append(common["abbreviations"][bare])
        elif (
            bare in common["number_suffixes"] and index > 0 and (last or words[index + 1].lower() == "of")
            and re.search(r"[a-z]", words[index - 1].lower()) and words[index - 1].lower() not in _NOT_NAMED
        ):
            out.append("Number")
        else:
            out.append(word)
    return " ".join(out)


def _skill_meaning(family: str | None, *texts: str) -> str | None:
    skill = skill_for_family(family)
    if skill is None:
        return None
    keys = {normalized(t) for t in texts if t}
    for _, spec in skill.fields():
        if keys & {normalized(alias) for alias in spec.aliases}:
            return spec.label
    return None


def recognize_label(
    printed: str | None,
    family: str | None = None,
    *,
    form: bool = False,
    name: str | None = None,
    number: str | None = None,
) -> RecognizedLabel:
    """`form`: the label is a form box's description. `name` / `number`:
    the field name and item number the layout already read from the page
    (a printed caption wins over the box's own description)."""

    text = normalize_space(printed or "").rstrip(" :")
    if not text and not name:
        return RecognizedLabel(printed="", display="", item_number=number or "", meaning=None,
                               source="missing", resolved=False)
    if _GENERIC_NAME.fullmatch(text) and not name:
        return RecognizedLabel(printed=text, display=text, item_number=number or "", meaning=None,
                               source="technical", resolved=False)
    source = "printed"
    item_number = number or ""
    is_choice = False
    if name:
        base = normalize_space(name).rstrip(" :")
        if form:
            source = "form"
    elif _TECHNICAL_NAME.fullmatch(text):
        base, source = display_label(text), "technical"
    elif form or _INSTRUCTION.match(text):
        found_number, base, is_choice = form_label(text)
        item_number = item_number or found_number
        source = "form"
    else:
        numbered = _PRINTED_NUMBER.match(text)
        if numbered:
            item_number = item_number or numbered.group(1).upper()
            text = text[numbered.end():]
        base = text
    spellings, meanings = _type_tables(family)
    key = label_key(base)
    if key in spellings:
        display = spellings[key]
        source = "alias" if source in ("printed", "technical") else source
    else:
        display = _expand_common(base)
        if display != base and source == "printed":
            source = "abbreviation"
    meaning = (
        meanings.get(key) or meanings.get(label_key(display))
        or _skill_meaning(family, base, display)
    )
    return RecognizedLabel(
        printed=normalize_space(printed or ""),
        display=display,
        item_number=item_number,
        meaning=meaning,
        source=source,
        resolved=bool(display) and not _GENERIC_NAME.fullmatch(display),
        is_choice=is_choice,
    )


def annotate_labels(layout: dict[str, Any], family: str | None) -> dict[str, Any]:
    """Adds `label_info` (a RecognizedLabel) to each field of the layout.
    Field names, values and the Excel export are unchanged."""

    for item in layout_fields(layout):
        form = bool(item.get("form_item"))
        parent = item.get("item") or {}
        item["label_info"] = recognize_label(
            item.get("label"),
            family,
            form=form,
            name=item.get("field_name") if form else None,
            number=(parent.get("number") or None) if form else None,
        ).as_dict()
    return layout


def label_audit(layout: dict[str, Any]) -> dict[str, Any]:
    """How every extracted value of an annotated layout is labelled: by
    source, the unresolved ones, and those whose display differs from the
    printed text."""

    by_source: dict[str, int] = {}
    unresolved = []
    rewritten = []
    total = 0
    for item in layout_fields(layout):
        if item.get("form_duplicate"):
            continue
        info = item["label_info"]
        total += 1
        by_source[info["source"]] = by_source.get(info["source"], 0) + 1
        entry = {
            "record_key": item.get("record_key"),
            "printed": info["printed"],
            "display": info["display"],
            "item_number": info["item_number"],
            "meaning": info["meaning"],
            "value": item.get("effective_value") or item.get("extracted_value") or item.get("document_value"),
            "page": item.get("page"),
        }
        if not info["resolved"]:
            unresolved.append(entry)
        elif info["display"] and label_key(info["display"]) != label_key(info["printed"]):
            rewritten.append(entry)
    return {
        "total": total,
        "resolved": total - len(unresolved),
        "by_source": by_source,
        "unresolved": unresolved,
        "rewritten": rewritten[:50],
        "rewritten_count": len(rewritten),
    }
