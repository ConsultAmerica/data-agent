"""The schema definition language of the Schema & Label Designer.

A definition is plain data (JSON): groups of typed fields, repeating groups
(tables) with nested child groups, and validation rules. Nothing in a
definition is ever executed: calculated fields use a fixed set of
operations, patterns are length-limited regular expressions compiled only
to validate them, and extraction instructions are text for a reviewer or
an extraction step — never commands to the platform.

Fields are bound to extracted data by reference (the Oracle mapping
``SourceRef``), so a schema decides how data is organised, labelled and
validated; it never changes the extracted values themselves.
"""

from __future__ import annotations

import re
from copy import deepcopy
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from app.oracle_templates.mapping import SourceRef

FieldType = Literal[
    "text", "number", "currency", "date", "boolean", "dropdown", "email", "address",
    "identifier", "signature", "attachment", "calculated",
]
GroupKind = Literal["section", "repeating", "object"]
Normalization = Literal["none", "trim", "upper", "lower", "date_iso", "number"]
RuleKind = Literal[
    "required", "pattern", "range", "allowed_values", "date_order", "sum_matches", "conditional_required",
]
FIELD_TYPES: tuple[str, ...] = FieldType.__args__  # type: ignore[attr-defined]

_FIELD_ID = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,5}$")
_GROUP_ID = re.compile(r"^[a-z][a-z0-9_]{0,60}$")
MAX_DEPTH = 3
MAX_FIELDS = 1500
MAX_PATTERN = 200
# A child schema may change only these properties of an inherited field.
OVERRIDABLE = frozenset({"label", "description", "instructions", "visible", "order", "required",
                         "allowed_values", "confidence_threshold", "normalization"})


class DefinitionError(ValueError):
    """The definition isn't valid; ``problems`` lists every reason."""

    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems[:10]))
        self.problems = problems


class Calculation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    op: Literal["sum", "add", "subtract", "multiply"]
    # Field ids (for "sum": one column of a repeating group).
    args: list[str] = Field(min_length=1, max_length=10)


class SchemaField(BaseModel):
    model_config = ConfigDict(extra="forbid")
    field_id: str = Field(min_length=1, max_length=120)
    label: str = Field(min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=1000)
    type: FieldType = "text"
    required: bool = False
    default: str | None = Field(default=None, max_length=500)
    allowed_values: list[str] = Field(default_factory=list, max_length=200)
    instructions: str | None = Field(default=None, max_length=2000)
    normalization: Normalization = "none"
    confidence_threshold: float | None = Field(default=None, ge=0, le=1)
    visible: bool = True
    evidence_required: bool = True
    source: SourceRef | None = None
    calculation: Calculation | None = None
    order: int = 0

    @field_validator("field_id")
    @classmethod
    def _id(cls, value: str) -> str:
        if not _FIELD_ID.fullmatch(value):
            raise ValueError("field ids are lower-case words separated by dots, e.g. contract.number")
        return value


class SchemaGroup(BaseModel):
    model_config = ConfigDict(extra="forbid")
    group_id: str = Field(min_length=1, max_length=61)
    label: str = Field(min_length=1, max_length=160)
    kind: GroupKind = "section"
    description: str | None = Field(default=None, max_length=1000)
    # Repeating groups: the extracted table their rows come from.
    source_dataset: str | None = Field(default=None, max_length=120)
    key_field: str | None = None
    # Nested repeating group: the field in this group that refers to the parent row.
    parent_key_field: str | None = None
    page_size: int = Field(default=25, ge=5, le=500)
    visible: bool = True
    fields: list[SchemaField] = Field(default_factory=list)
    children: list["SchemaGroup"] = Field(default_factory=list)

    @field_validator("group_id")
    @classmethod
    def _id(cls, value: str) -> str:
        if not _GROUP_ID.fullmatch(value):
            raise ValueError("group ids are lower-case words joined by underscores")
        return value


class SchemaRule(BaseModel):
    model_config = ConfigDict(extra="forbid")
    rule_id: str = Field(min_length=1, max_length=80)
    kind: RuleKind
    fields: list[str] = Field(min_length=1, max_length=10)
    # Plain values only: pattern, min, max, values, when_field, when_value, tolerance, group.
    params: dict[str, str | float | int | bool | list[str] | None] = Field(default_factory=dict)
    message: str | None = Field(default=None, max_length=300)
    severity: Literal["error", "warning"] = "error"


class FieldOverride(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: str | None = Field(default=None, max_length=160)
    description: str | None = Field(default=None, max_length=1000)
    instructions: str | None = Field(default=None, max_length=2000)
    visible: bool | None = None
    order: int | None = None
    required: bool | None = None
    allowed_values: list[str] | None = None
    confidence_threshold: float | None = Field(default=None, ge=0, le=1)
    normalization: Normalization | None = None


class Definition(BaseModel):
    model_config = ConfigDict(extra="forbid")
    groups: list[SchemaGroup] = Field(default_factory=list)
    rules: list[SchemaRule] = Field(default_factory=list)
    # Child schemas: changes to inherited fields, by field id.
    overrides: dict[str, FieldOverride] = Field(default_factory=dict)


SchemaGroup.model_rebuild()


def parse_definition(data: object) -> Definition:
    """A definition from untrusted JSON data, or DefinitionError."""

    try:
        return Definition.model_validate(data)
    except ValidationError as exc:
        problems = []
        for error in exc.errors()[:20]:
            where = ".".join(str(part) for part in error["loc"])
            problems.append(f"{where}: {error['msg']}")
        raise DefinitionError(problems) from exc


def iter_groups(groups: list[SchemaGroup], depth: int = 1):
    for group in groups:
        yield group, depth
        yield from iter_groups(group.children, depth + 1)


def all_fields(definition: Definition) -> list[tuple[SchemaGroup, SchemaField]]:
    return [(group, field) for group, _depth in iter_groups(definition.groups) for field in group.fields]


def check(definition: Definition, *, inherited: Definition | None = None) -> list[str]:
    """Every problem with an effective definition (empty = valid)."""

    problems: list[str] = []
    fields = all_fields(definition)
    if len(fields) > MAX_FIELDS:
        problems.append(f"At most {MAX_FIELDS} fields.")
    seen: dict[str, str] = {}
    for group, field in fields:
        if field.field_id in seen:
            problems.append(f"Duplicate field id {field.field_id!r} (in {seen[field.field_id]!r} and {group.label!r}).")
        seen[field.field_id] = group.label
        if field.type == "calculated" and field.calculation is None:
            problems.append(f"{field.field_id}: a calculated field needs a calculation.")
        if field.type == "dropdown" and not field.allowed_values:
            problems.append(f"{field.field_id}: a dropdown needs allowed values.")
    group_ids: set[str] = set()
    for group, depth in iter_groups(definition.groups):
        if group.group_id in group_ids:
            problems.append(f"Duplicate group id {group.group_id!r}.")
        group_ids.add(group.group_id)
        if depth > MAX_DEPTH:
            problems.append(f"{group.group_id}: groups nest at most {MAX_DEPTH} levels deep.")
        names = {f.field_id for f in group.fields}
        for key in (group.key_field, group.parent_key_field):
            if key and key not in names:
                problems.append(f"{group.group_id}: key field {key!r} is not a field of this group.")
        if group.parent_key_field and group.kind != "repeating":
            problems.append(f"{group.group_id}: only a repeating group can have a parent key.")
    for group, field in fields:
        if field.calculation is not None:
            for arg in field.calculation.args:
                if arg not in seen:
                    problems.append(f"{field.field_id}: calculation refers to unknown field {arg!r}.")
    rule_ids: set[str] = set()
    for rule in definition.rules:
        if rule.rule_id in rule_ids:
            problems.append(f"Duplicate rule id {rule.rule_id!r}.")
        rule_ids.add(rule.rule_id)
        for name in rule.fields:
            if name not in seen:
                problems.append(f"Rule {rule.rule_id}: unknown field {name!r}.")
        if rule.kind == "pattern":
            pattern = rule.params.get("pattern")
            if not isinstance(pattern, str) or not pattern or len(pattern) > MAX_PATTERN:
                problems.append(f"Rule {rule.rule_id}: a pattern of 1–{MAX_PATTERN} characters is required.")
            else:
                try:
                    re.compile(pattern)
                except re.error as exc:
                    problems.append(f"Rule {rule.rule_id}: invalid pattern ({exc}).")
        if rule.kind == "date_order" and len(rule.fields) != 2:
            problems.append(f"Rule {rule.rule_id}: date order compares exactly two fields (earlier, later).")
        if rule.kind == "conditional_required" and not rule.params.get("when_field"):
            problems.append(f"Rule {rule.rule_id}: needs a 'when_field'.")
        when = rule.params.get("when_field")
        if isinstance(when, str) and when and when not in seen:
            problems.append(f"Rule {rule.rule_id}: unknown field {when!r}.")
    if inherited is not None:
        inherited_ids = {f.field_id for _g, f in all_fields(inherited)}
        for field_id in definition.overrides:
            if field_id not in inherited_ids:
                problems.append(f"Override for {field_id!r}: no such field in the parent schema.")
    return problems


def merge(parent: Definition | None, own: Definition) -> Definition:
    """The effective definition: the parent's, with this schema's overrides
    applied to inherited fields, its own groups added (or, under the same
    group id, its fields appended) and its rules added."""

    if parent is None:
        return Definition(groups=deepcopy(own.groups), rules=deepcopy(own.rules))
    groups = deepcopy(parent.groups)
    by_id = {group.group_id: group for group, _d in iter_groups(groups)}
    for group in own.groups:
        target = by_id.get(group.group_id)
        if target is None:
            groups.append(deepcopy(group))
        else:
            target.fields.extend(deepcopy(group.fields))
            target.children.extend(deepcopy(group.children))
    for group, _depth in iter_groups(groups):
        for index, field in enumerate(group.fields):
            override = own.overrides.get(field.field_id)
            if override is None:
                continue
            changes = {k: v for k, v in override.model_dump(exclude_none=True).items() if k in OVERRIDABLE}
            group.fields[index] = field.model_copy(update=changes)
        group.fields.sort(key=lambda f: f.order)
    return Definition(groups=groups, rules=[*deepcopy(parent.rules), *deepcopy(own.rules)])


def diff(old: Definition, new: Definition) -> dict:
    """Field differences between two effective definitions, by canonical id."""

    before = {f.field_id: f for _g, f in all_fields(old)}
    after = {f.field_id: f for _g, f in all_fields(new)}
    changes = []
    for field_id in sorted(set(before) | set(after)):
        a, b = before.get(field_id), after.get(field_id)
        if a is None:
            changes.append({"field_id": field_id, "change": "added", "label": b.label})
            continue
        if b is None:
            changes.append({"field_id": field_id, "change": "removed", "label": a.label})
            continue
        if a.type != b.type:
            changes.append({"field_id": field_id, "change": "type_changed", "from": a.type, "to": b.type, "label": b.label})
        if (a.source.model_dump() if a.source else None) != (b.source.model_dump() if b.source else None):
            changes.append({"field_id": field_id, "change": "source_changed", "label": b.label})
        if a.label != b.label:
            changes.append({"field_id": field_id, "change": "label_changed", "from": a.label, "to": b.label})
        if a.required != b.required:
            changes.append({"field_id": field_id, "change": "required_changed", "to": b.required, "label": b.label})
    return {"changes": changes, "breaking": [c for c in changes if c["change"] in {"removed", "type_changed", "source_changed"}]}


# ---------------------------------------------------------------- labels

_ABBREVIATIONS = {
    "no": "Number", "num": "Number", "nbr": "Number", "nm": "Name", "dt": "Date", "eff": "Effective",
    "exp": "Expiration", "amt": "Amount", "qty": "Quantity", "uom": "Unit of Measure", "po": "Purchase Order",
    "inv": "Invoice", "desc": "Description", "addr": "Address", "acct": "Account", "id": "ID", "ref": "Reference",
    "tot": "Total", "txn": "Transaction", "dob": "Date of Birth", "ssn": "SSN", "ein": "EIN", "clin": "CLIN",
    "naics": "NAICS", "cage": "CAGE", "uei": "UEI", "gpa": "GPA", "far": "FAR", "dfars": "DFARS", "sow": "SOW",
    "bu": "Business Unit", "pct": "Percent", "yr": "Year", "mo": "Month", "st": "State", "zip": "ZIP Code",
}
_TOTAL_FIRST = {"total", "tot"}


def humanize(raw: str) -> str:
    """A readable label from a raw key: "contract_no" → "Contract Number",
    "eff_dt" → "Effective Date", "amt_total" → "Total Amount"."""

    text = re.sub(r"^\s*\(?[0-9]{1,3}[A-Za-z]?[.)]\s*", "", raw or "")
    text = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", text)
    words = [w for w in re.split(r"[^A-Za-z0-9]+", text) if w]
    if not words:
        return raw.strip() or "Field"
    lowered = [w.lower() for w in words]
    if len(lowered) == 2 and lowered[1] in _TOTAL_FIRST:  # amt_total → Total Amount
        lowered = [lowered[1], lowered[0]]
    out = []
    for word, original in zip(lowered, words):
        if word in _ABBREVIATIONS:
            out.append(_ABBREVIATIONS[word])
        elif original.isupper() and len(original) > 1 and original.isalpha() and len(original) <= 5:
            out.append(original)
        else:
            out.append(word.capitalize())
    return " ".join(out)


def slug(text: str, *, prefix: str = "") -> str:
    base = re.sub(r"[^a-z0-9]+", "_", re.sub(r"^\s*\(?[0-9]{1,3}[A-Za-z]?[.)]\s*", "", text or "").lower()).strip("_")
    base = re.sub(r"_+", "_", base)[:50] or "field"
    if base[0].isdigit():
        base = f"f_{base}"
    return f"{prefix}.{base}" if prefix else base
