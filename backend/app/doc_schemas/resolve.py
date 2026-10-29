"""Builds a review form from a schema and a document's extracted data, and
checks the schema's validation rules against it.

Values always come from the document's staging workbook (the extraction),
read through each field's binding; an unbound field is looked up by its
label among the document's extracted fields. Nothing here writes data:
rules report problems, and a schema change can never overwrite a value a
person approved.
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, Field

from app.doc_schemas.definition import Definition, SchemaField, SchemaGroup, SchemaRule
from app.oracle_templates.mapping import (
    SourceField,
    _pair_cell,
    _score,
    apply_transform,
    catalogue,
    text_of,
)
from app.staging.models import StagingCell, StagingDataset, StagingRecord, StagingWorkbook

MAX_ROWS = 500
_MATCH_MIN = 0.75


class FormValue(BaseModel):
    value: str = ""
    # found | matched_by_label | calculated | default | not_found
    status: str = "not_found"
    review_status: str | None = None
    page: int | None = None
    highlight: str | None = None
    document_label: str | None = None
    method: str | None = None


class FormField(BaseModel):
    field_id: str
    label: str
    type: str
    required: bool
    description: str | None = None
    instructions: str | None = None
    value: FormValue


class FormRow(BaseModel):
    row_id: str
    cells: dict[str, FormValue]
    children: list["FormGroup"] = Field(default_factory=list)


class FormGroup(BaseModel):
    group_id: str
    label: str
    kind: str
    description: str | None = None
    fields: list[FormField] = Field(default_factory=list)
    columns: list[FormField] = Field(default_factory=list)
    rows: list[FormRow] = Field(default_factory=list)
    total_rows: int = 0
    page_size: int = 25
    children: list["FormGroup"] = Field(default_factory=list)


class FormIssue(BaseModel):
    severity: Literal["error", "warning"]
    rule_id: str | None
    field_id: str | None
    message: str
    row: int | None = None


class Form(BaseModel):
    groups: list[FormGroup]
    issues: list[FormIssue]
    found: int
    not_found: int


FormRow.model_rebuild()
FormGroup.model_rebuild()


def _cell_value(cell: StagingCell | None, status: str = "found", method: str | None = None) -> FormValue:
    if cell is None or not text_of(cell.value).strip():
        return FormValue()
    provenance = cell.provenance
    return FormValue(
        value=text_of(cell.value),
        status=status,
        review_status=cell.review_status,
        page=provenance.source_page if provenance and provenance.source_page and provenance.source_page > 0 else None,
        highlight=(provenance.highlight_text if provenance else None) or text_of(cell.value),
        document_label=provenance.anchor_text if provenance else None,
        method=method,
    )


def _dataset(workbook: StagingWorkbook, dataset_id: str | None) -> StagingDataset | None:
    return next((d for d in workbook.datasets if d.dataset_id == dataset_id), None)


def _normalize(value: FormValue, field: SchemaField) -> FormValue:
    if not value.value or field.normalization == "none":
        return value
    if field.normalization == "lower":
        return value.model_copy(update={"value": value.value.lower()})
    transformed, problem = apply_transform(value.value, field.normalization)
    return value if problem else value.model_copy(update={"value": transformed})


def _by_label(field: SchemaField, fields: list[SourceField]) -> tuple[SourceField, str] | None:
    column = {"technical_name": field.field_id.rsplit(".", 1)[-1], "display_label": field.label}
    best: tuple[float, SourceField, str] | None = None
    for candidate in fields:
        if candidate.ref.shape == "column" or not candidate.sample.strip():
            continue
        scored = _score(column, candidate)
        if scored and scored[0] >= _MATCH_MIN and (best is None or scored[0] > best[0]):
            best = (scored[0], candidate, scored[1])
    return (best[1], best[2]) if best else None


def _section_value(workbook: StagingWorkbook, field: SchemaField, fields: list[SourceField]) -> FormValue:
    source = field.source
    if source is not None and source.kind == "field":
        dataset = _dataset(workbook, source.dataset_id)
        cell = None
        if dataset is not None:
            if source.shape == "pair":
                cell = _pair_cell(dataset, source)
            elif dataset.records:
                cell = dataset.records[0].cells.get(source.field or "")
        return _cell_value(cell)
    if source is not None and source.kind == "constant":
        return FormValue(value=source.constant or "", status="found", method="constant")
    match = _by_label(field, fields)
    if match is None:
        return FormValue()
    candidate, method = match
    dataset = _dataset(workbook, candidate.ref.dataset_id)
    cell = None
    if dataset is not None:
        cell = _pair_cell(dataset, candidate.ref) if candidate.ref.shape == "pair" else (
            dataset.records[0].cells.get(candidate.ref.field or "") if dataset.records else None
        )
    found = _cell_value(cell, "matched_by_label", f"matched by label ({method})")
    if candidate.document_label and not found.document_label:
        found.document_label = candidate.document_label
    return found


def _column_for(field: SchemaField, dataset: StagingDataset) -> str | None:
    if field.source is not None and field.source.kind == "field" and field.source.dataset_id == dataset.dataset_id:
        return field.source.field
    wanted = field.label.strip().lower()
    for column in dataset.columns:
        if column.display_label.strip().lower() == wanted or column.key == field.field_id.rsplit(".", 1)[-1]:
            return column.canonical_field
    return None


def _rows(group: SchemaGroup, workbook: StagingWorkbook, records: list[StagingRecord] | None = None) -> tuple[list[FormRow], int]:
    dataset = _dataset(workbook, group.source_dataset)
    if dataset is None:
        return [], 0
    records = dataset.records if records is None else records
    columns = {field.field_id: _column_for(field, dataset) for field in group.fields}
    rows: list[FormRow] = []
    for record in records[:MAX_ROWS]:
        cells = {}
        for field in group.fields:
            column = columns[field.field_id]
            cells[field.field_id] = _normalize(_cell_value(record.cells.get(column)) if column else FormValue(), field)
        rows.append(FormRow(row_id=record.record_id, cells=cells))
    return rows, len(records)


def _form_field(field: SchemaField, value: FormValue) -> FormField:
    return FormField(field_id=field.field_id, label=field.label, type=field.type, required=field.required,
                     description=field.description, instructions=field.instructions, value=value)


def _number(text: str) -> float | None:
    converted, problem = apply_transform(text, "number")
    if problem or not converted:
        return None
    try:
        return float(converted)
    except ValueError:
        return None


def _calculate(field: SchemaField, values: dict[str, str], groups: list[FormGroup]) -> FormValue:
    calc = field.calculation
    if calc is None:
        return FormValue()
    if calc.op == "sum":
        column = calc.args[0]
        numbers = [
            _number(row.cells[column].value)
            for group in _walk(groups) for row in group.rows if column in row.cells and row.cells[column].value
        ]
        numbers = [n for n in numbers if n is not None]
        result = sum(numbers) if numbers else None
    else:
        args = [_number(values.get(a, "")) for a in calc.args]
        if any(a is None for a in args):
            return FormValue(status="not_found", method="calculation needs every input")
        result = args[0]
        for arg in args[1:]:
            result = result + arg if calc.op == "add" else result - arg if calc.op == "subtract" else result * arg
    if result is None:
        return FormValue(status="not_found", method="calculation")
    return FormValue(value=f"{result:.2f}".rstrip("0").rstrip(".") if result % 1 else str(int(result)),
                     status="calculated", method=f"calculated ({calc.op})")


def _walk(groups: list[FormGroup]):
    for group in groups:
        yield group
        yield from _walk(group.children)


def _build_group(group: SchemaGroup, workbook: StagingWorkbook, fields: list[SourceField]) -> FormGroup:
    built = FormGroup(group_id=group.group_id, label=group.label, kind=group.kind,
                      description=group.description, page_size=group.page_size)
    if group.kind == "repeating":
        built.columns = [_form_field(f, FormValue()) for f in group.fields if f.visible]
        built.rows, built.total_rows = _rows(group, workbook)
        for child in group.children:
            if child.kind == "repeating" and child.parent_key_field and group.key_field:
                child_dataset = _dataset(workbook, child.source_dataset)
                if child_dataset is None:
                    continue
                parent_column = child.parent_key_field
                child_field = next(f for f in child.fields if f.field_id == parent_column)
                column = _column_for(child_field, child_dataset)
                for row in built.rows:
                    key = row.cells.get(group.key_field, FormValue()).value
                    matching = [r for r in child_dataset.records if column and text_of(
                        r.cells.get(column).value if r.cells.get(column) else None) == key]
                    nested = _build_group(child.model_copy(update={"children": []}), workbook, fields)
                    nested.rows, nested.total_rows = _rows(child, workbook, matching)
                    row.children.append(nested)
            else:
                built.children.append(_build_group(child, workbook, fields))
    else:
        for field in sorted(group.fields, key=lambda f: f.order):
            if not field.visible or field.type == "calculated":
                if field.type == "calculated" and field.visible:
                    built.fields.append(_form_field(field, FormValue()))
                continue
            value = _normalize(_section_value(workbook, field, fields), field)
            if not value.value and field.default:
                value = FormValue(value=field.default, status="default", method="default value")
            built.fields.append(_form_field(field, value))
        built.children = [_build_group(child, workbook, fields) for child in group.children]
    return built


def build_form(workbook: StagingWorkbook, definition: Definition) -> Form:
    fields = catalogue(workbook)
    groups = [_build_group(group, workbook, fields) for group in definition.groups if group.visible]
    values = {f.field_id: f.value.value for g in _walk(groups) for f in g.fields}
    schema_fields = {f.field_id: f for g in _all(definition.groups) for f in g.fields}
    for group in _walk(groups):
        for index, form_field in enumerate(group.fields):
            source = schema_fields.get(form_field.field_id)
            if source is not None and source.type == "calculated":
                group.fields[index] = form_field.model_copy(update={"value": _calculate(source, values, groups)})
                values[form_field.field_id] = group.fields[index].value.value
    issues = validate_form(definition, groups, values)
    section_values = [f.value for g in _walk(groups) for f in g.fields]
    found = sum(1 for v in section_values if v.value)
    return Form(groups=groups, issues=issues, found=found, not_found=len(section_values) - found)


def _all(groups: list[SchemaGroup]):
    for group in groups:
        yield group
        yield from _all(group.children)


def _date(text: str) -> str | None:
    converted, problem = apply_transform(text, "date_iso")
    return None if problem or not converted else converted


def validate_form(definition: Definition, groups: list[FormGroup], values: dict[str, str]) -> list[FormIssue]:
    issues: list[FormIssue] = []
    schema_fields = {f.field_id: f for g in _all(definition.groups) for f in g.fields}
    column_values: dict[str, list[str]] = {}
    for group in _walk(groups):
        for row in group.rows:
            for field_id, cell in row.cells.items():
                column_values.setdefault(field_id, []).append(cell.value)

    def value_of(field_id: str) -> str:
        return values.get(field_id, "").strip()

    for field_id, field in schema_fields.items():
        if field.required and field_id in values and not value_of(field_id):
            issues.append(FormIssue(severity="error", rule_id=None, field_id=field_id, message=f"{field.label} is required."))
        if field.allowed_values and value_of(field_id) and value_of(field_id) not in field.allowed_values:
            issues.append(FormIssue(severity="warning", rule_id=None, field_id=field_id,
                                    message=f"{field.label}: {value_of(field_id)!r} is not an allowed value."))
    for rule in definition.rules:
        issues.extend(_rule(rule, schema_fields, value_of, column_values))
    return issues


def _rule(rule: SchemaRule, fields: dict[str, SchemaField], value_of, column_values: dict[str, list[str]]) -> list[FormIssue]:
    def issue(message: str, field_id: str | None = None, row: int | None = None) -> FormIssue:
        return FormIssue(severity=rule.severity, rule_id=rule.rule_id, field_id=field_id or rule.fields[0],
                         message=rule.message or message, row=row)

    label = lambda fid: fields[fid].label if fid in fields else fid  # noqa: E731
    out: list[FormIssue] = []
    params = rule.params
    if rule.kind == "required":
        for fid in rule.fields:
            if fid in column_values:
                for i, v in enumerate(column_values[fid], start=1):
                    if not v.strip():
                        out.append(issue(f"{label(fid)} is required (row {i}).", fid, i))
            elif not value_of(fid):
                out.append(issue(f"{label(fid)} is required.", fid))
    elif rule.kind == "pattern":
        pattern = re.compile(str(params.get("pattern", "")))
        for fid in rule.fields:
            for i, v in enumerate(column_values.get(fid) or [value_of(fid)], start=1):
                if v and not pattern.fullmatch(v[:1000]):
                    out.append(issue(f"{label(fid)} {v!r} doesn't match the expected format.", fid,
                                     i if fid in column_values else None))
    elif rule.kind == "range":
        low, high = params.get("min"), params.get("max")
        for fid in rule.fields:
            for i, v in enumerate(column_values.get(fid) or [value_of(fid)], start=1):
                number = _number(v) if v else None
                if v and number is None:
                    out.append(issue(f"{label(fid)} {v!r} is not a number.", fid))
                elif number is not None and ((low is not None and number < float(low)) or (high is not None and number > float(high))):
                    out.append(issue(f"{label(fid)} {v} is outside {low}–{high}.", fid, i if fid in column_values else None))
    elif rule.kind == "allowed_values":
        allowed = params.get("values") or []
        for fid in rule.fields:
            for v in column_values.get(fid) or [value_of(fid)]:
                if v and v not in allowed:
                    out.append(issue(f"{label(fid)} {v!r} is not an allowed value.", fid))
    elif rule.kind == "date_order":
        earlier, later = rule.fields
        a, b = _date(value_of(earlier)), _date(value_of(later))
        if a and b and a > b:
            out.append(issue(f"{label(later)} ({b}) precedes {label(earlier)} ({a}).", later))
    elif rule.kind == "sum_matches":
        column, total = rule.fields[0], rule.fields[-1]
        numbers = [n for n in (_number(v) for v in column_values.get(column, [])) if n is not None]
        expected = _number(value_of(total))
        tolerance = float(params.get("tolerance") or 0.01)
        if numbers and expected is not None and abs(sum(numbers) - expected) > tolerance:
            out.append(issue(f"{label(column)} adds up to {sum(numbers):.2f}, but {label(total)} is {expected:.2f}.", total))
    elif rule.kind == "conditional_required":
        when = str(params.get("when_field") or "")
        expected = params.get("when_value")
        active = bool(value_of(when)) if expected in (None, "") else value_of(when) == str(expected)
        if active:
            for fid in rule.fields:
                if not value_of(fid):
                    out.append(issue(f"{label(fid)} is required when {label(when)} is set.", fid))
    return out
