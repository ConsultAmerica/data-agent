"use client";

import {
  ArrowDown,
  ArrowUp,
  Calculator,
  CalendarDays,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Download,
  EyeOff,
  FileSignature,
  Fingerprint,
  GripVertical,
  Hash,
  History,
  Layers,
  ListChecks,
  ListTree,
  Mail,
  MapPin,
  Monitor,
  Paperclip,
  Plus,
  Redo2,
  Search,
  Smartphone,
  Sparkles,
  Table2,
  Tablet,
  Trash2,
  Type,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import SchemaForm, { type FormLayout } from "@/components/schemas/schema-form";
import { searchDocuments } from "@/lib/documents";
import {
  STATUS_LABEL,
  STATUS_TONE,
  discoverFields,
  effectiveByVersion,
  emptyDefinition,
  exportSchema,
  getSchema,
  getVersion,
  mergeDefinition,
  newDraft,
  previewForm,
  saveVersion,
  slugId,
  transition,
  type Definition,
  type FieldOverride,
  type FieldType,
  type Form,
  type GroupKind,
  type RuleKind,
  type SchemaDetail,
  type SchemaField,
  type SchemaGroup,
  type SchemaRule,
  type VersionDetail,
} from "@/lib/doc-schemas";
import type { DocumentSummary } from "@/types/document";

const PALETTE: { type: FieldType; label: string; icon: LucideIcon }[] = [
  { type: "text", label: "Text", icon: Type },
  { type: "number", label: "Number", icon: Hash },
  { type: "currency", label: "Currency", icon: CircleDollarSign },
  { type: "date", label: "Date", icon: CalendarDays },
  { type: "boolean", label: "Yes / No", icon: CheckSquare },
  { type: "dropdown", label: "Dropdown", icon: ListChecks },
  { type: "email", label: "Email", icon: Mail },
  { type: "address", label: "Address", icon: MapPin },
  { type: "identifier", label: "Identifier", icon: Fingerprint },
  { type: "signature", label: "Signature", icon: FileSignature },
  { type: "attachment", label: "Attachment reference", icon: Paperclip },
  { type: "calculated", label: "Calculated", icon: Calculator },
];
const GROUP_PALETTE: { kind: GroupKind; label: string; icon: LucideIcon }[] = [
  { kind: "section", label: "Field group", icon: Layers },
  { kind: "repeating", label: "Table / repeating group", icon: Table2 },
  { kind: "object", label: "Nested object", icon: ListTree },
];
const RULE_KINDS: { kind: RuleKind; label: string }[] = [
  { kind: "required", label: "Required" },
  { kind: "pattern", label: "Matches pattern" },
  { kind: "range", label: "Number in range" },
  { kind: "allowed_values", label: "Allowed values" },
  { kind: "date_order", label: "Date order (earlier, later)" },
  { kind: "sum_matches", label: "Column sum matches total" },
  { kind: "conditional_required", label: "Required when…" },
];
type Selection = { kind: "field"; id: string } | { kind: "group"; id: string } | null;
type Device = "desktop" | "tablet" | "mobile";
const DEVICE_WIDTH: Record<Device, string> = { desktop: "100%", tablet: "768px", mobile: "390px" };

function walk(groups: SchemaGroup[], fn: (group: SchemaGroup, parent: SchemaGroup | null) => void, parent: SchemaGroup | null = null) {
  for (const group of groups) {
    fn(group, parent);
    walk(group.children, fn, group);
  }
}

function findGroup(groups: SchemaGroup[], id: string): SchemaGroup | null {
  let found: SchemaGroup | null = null;
  walk(groups, (g) => { if (g.group_id === id) found = g; });
  return found;
}

function ownField(definition: Definition, fieldId: string): SchemaField | null {
  let found: SchemaField | null = null;
  walk(definition.groups, (g) => { const f = g.fields.find((x) => x.field_id === fieldId); if (f) found = f; });
  return found;
}

function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}_${n++}`;
  return id;
}

export default function SchemaDesigner({ schemaId }: { schemaId: number }) {
  const router = useRouter();
  const params = useSearchParams();
  const [schema, setSchema] = useState<SchemaDetail | null>(null);
  const [version, setVersion] = useState<VersionDetail | null>(null);
  const [parent, setParent] = useState<Definition | null>(null);
  const [own, setOwn] = useState<Definition>(emptyDefinition());
  const [past, setPast] = useState<Definition[]>([]);
  const [future, setFuture] = useState<Definition[]>([]);
  const [selected, setSelected] = useState<Selection>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [save, setSave] = useState<"saved" | "saving" | "unsaved" | "error">("saved");
  const [error, setError] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<"properties" | "rules" | "history">("properties");
  const [fieldQuery, setFieldQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [previewDoc, setPreviewDoc] = useState<DocumentSummary | null>(null);
  const [preview, setPreview] = useState<Form | null>(null);
  const [device, setDevice] = useState<Device>("desktop");
  const [layout, setLayout] = useState<FormLayout>("form");
  const [showPreview, setShowPreview] = useState(true);
  const dirty = useRef(false);

  const load = useCallback(async (versionId?: number) => {
    try {
      const detail = await getSchema(schemaId);
      const target = versionId ?? detail.latest?.id;
      if (!target) return;
      const loaded = await getVersion(schemaId, target);
      setSchema(detail);
      setVersion(loaded);
      setOwn({ ...emptyDefinition(), ...loaded.definition, overrides: loaded.definition.overrides ?? {} });
      setProblems(loaded.problems);
      setPast([]);
      setFuture([]);
      setSave("saved");
      dirty.current = false;
      setParent(loaded.version.parent_version_id ? await effectiveByVersion(loaded.version.parent_version_id) : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to open the schema.");
    }
  }, [schemaId]);

  // Reload only when the requested version changes (never on unrelated
  // re-renders, which would drop unsaved edits).
  const requestedVersion = Number(params.get("version")) || undefined;
  useEffect(() => {
    void Promise.resolve().then(() => load(requestedVersion));
  }, [load, requestedVersion]);

  const editable = Boolean(version?.editable);
  const effective = useMemo(() => mergeDefinition(parent, own), [parent, own]);
  const inherited = useMemo(() => new Set(version?.inherited_field_ids ?? []), [version]);
  const ownGroupIds = useMemo(() => { const s = new Set<string>(); walk(own.groups, (g) => s.add(g.group_id)); return s; }, [own]);
  const allFieldIds = useMemo(() => { const s = new Set<string>(); walk(effective.groups, (g) => g.fields.forEach((f) => s.add(f.field_id))); return s; }, [effective]);

  // ---------------------------------------------------------------- edits

  function change(update: (draft: Definition) => void) {
    if (!editable) return;
    setPast((p) => [...p.slice(-49), own]);
    setFuture([]);
    const next = structuredClone(own);
    update(next);
    setOwn(next);
    dirty.current = true;
    setSave("unsaved");
  }

  const undo = () => { if (!past.length) return; setFuture((f) => [own, ...f]); setOwn(past[past.length - 1]); setPast((p) => p.slice(0, -1)); dirty.current = true; setSave("unsaved"); };
  const redo = () => { if (!future.length) return; setPast((p) => [...p, own]); setOwn(future[0]); setFuture((f) => f.slice(1)); dirty.current = true; setSave("unsaved"); };

  // Autosave drafts a moment after the last change.
  useEffect(() => {
    if (!editable || !dirty.current || !version) return;
    const timer = setTimeout(async () => {
      setSave("saving");
      try {
        const saved = await saveVersion(schemaId, version.version.id, { definition: own });
        setProblems(saved.problems);
        dirty.current = false;
        setSave("saved");
        setError(null);
      } catch (err) {
        setSave("error");
        setError(err instanceof Error ? err.message : "Save failed.");
      }
    }, 900);
    return () => clearTimeout(timer);
  }, [own, editable, schemaId, version]);

  function ensureOwnGroup(draft: Definition, groupId: string): SchemaGroup {
    const existing = findGroup(draft.groups, groupId);
    if (existing) return existing;
    const inheritedGroup = findGroup(effective.groups, groupId);
    const created: SchemaGroup = { group_id: groupId, label: inheritedGroup?.label ?? groupId, kind: inheritedGroup?.kind ?? "section", fields: [], children: [] };
    draft.groups.push(created);
    return created;
  }

  function addField(type: FieldType, groupId?: string) {
    change((draft) => {
      let target = groupId ?? (selected?.kind === "group" ? selected.id : effective.groups[0]?.group_id);
      if (!target) {
        draft.groups.push({ group_id: uniqueId("general", ownGroupIds), label: "General", kind: "section", fields: [], children: [] });
        target = draft.groups[draft.groups.length - 1].group_id;
      }
      const group = ensureOwnGroup(draft, target);
      const label = `New ${PALETTE.find((p) => p.type === type)?.label.toLowerCase() ?? "field"}`;
      const field: SchemaField = {
        field_id: uniqueId(slugId(label, "custom"), allFieldIds), label, type,
        order: (findGroup(effective.groups, target)?.fields.length ?? 0) * 10,
        ...(type === "dropdown" ? { allowed_values: ["Option 1"] } : {}),
        ...(type === "calculated" ? { calculation: { op: "add", args: [] } } : {}),
      };
      group.fields.push(field);
      setSelected({ kind: "field", id: field.field_id });
    });
  }

  function addGroup(kind: GroupKind) {
    change((draft) => {
      const label = kind === "repeating" ? "New table" : kind === "object" ? "New object" : "New group";
      const taken = new Set<string>();
      walk(effective.groups, (g) => taken.add(g.group_id));
      const group: SchemaGroup = { group_id: uniqueId(label.toLowerCase().replace(/\s+/g, "_"), taken), label, kind, fields: [], children: [] };
      const parentGroup = selected?.kind === "group" && kind === "object" ? findGroup(draft.groups, selected.id) : null;
      if (parentGroup) parentGroup.children.push(group);
      else draft.groups.push(group);
      setSelected({ kind: "group", id: group.group_id });
    });
  }

  function updateField(fieldId: string, patch: Partial<SchemaField>) {
    change((draft) => {
      const field = ownField(draft, fieldId);
      if (field) {
        Object.assign(field, patch);
        if (patch.field_id && selected?.kind === "field") setSelected({ kind: "field", id: patch.field_id });
        return;
      }
      const allowed: (keyof FieldOverride)[] = ["label", "description", "instructions", "visible", "order", "required", "allowed_values", "confidence_threshold", "normalization"];
      const next: FieldOverride = { ...(draft.overrides[fieldId] ?? {}) };
      for (const key of allowed) if (key in patch) (next as Record<string, unknown>)[key] = (patch as Record<string, unknown>)[key];
      draft.overrides[fieldId] = next;
    });
  }

  function updateGroup(groupId: string, patch: Partial<SchemaGroup>) {
    change((draft) => { const group = findGroup(draft.groups, groupId); if (group) Object.assign(group, patch); });
  }

  function removeField(fieldId: string) {
    if (inherited.has(fieldId)) {
      updateField(fieldId, { visible: false });
      return;
    }
    change((draft) => {
      walk(draft.groups, (g) => { g.fields = g.fields.filter((f) => f.field_id !== fieldId); });
      draft.rules = draft.rules.filter((r) => !r.fields.includes(fieldId));
    });
    setSelected(null);
  }

  function removeGroup(groupId: string) {
    change((draft) => {
      draft.groups = draft.groups.filter((g) => g.group_id !== groupId);
      walk(draft.groups, (g) => { g.children = g.children.filter((c) => c.group_id !== groupId); });
    });
    setSelected(null);
  }

  /** Reorders a group's fields (orders of own fields, overrides of inherited ones). */
  function reorder(groupId: string, fieldIds: string[]) {
    change((draft) => {
      fieldIds.forEach((id, index) => {
        const field = ownField(draft, id);
        if (field) field.order = index * 10;
        else draft.overrides[id] = { ...(draft.overrides[id] ?? {}), order: index * 10 };
      });
      void groupId;
    });
  }

  function moveField(fieldId: string, toGroup: string, beforeId: string | null) {
    const target = findGroup(effective.groups, toGroup);
    const sourceGroup = (() => { let g: SchemaGroup | null = null; walk(effective.groups, (x) => { if (x.fields.some((f) => f.field_id === fieldId)) g = x; }); return g as SchemaGroup | null; })();
    if (!target || !sourceGroup) return;
    if (sourceGroup.group_id === toGroup) {
      const ids = target.fields.map((f) => f.field_id).filter((id) => id !== fieldId);
      const at = beforeId ? ids.indexOf(beforeId) : ids.length;
      ids.splice(at < 0 ? ids.length : at, 0, fieldId);
      reorder(toGroup, ids);
      return;
    }
    if (inherited.has(fieldId)) {
      setError("Inherited fields stay in their parent's group; reorder them within it instead.");
      return;
    }
    change((draft) => {
      let moved: SchemaField | null = null;
      walk(draft.groups, (g) => { const i = g.fields.findIndex((f) => f.field_id === fieldId); if (i >= 0) { moved = g.fields[i]; g.fields.splice(i, 1); } });
      if (!moved) return;
      const destination = ensureOwnGroup(draft, toGroup);
      (moved as SchemaField).order = (target.fields.length + 1) * 10;
      destination.fields.push(moved);
    });
  }

  // ---------------------------------------------------------------- preview

  useEffect(() => {
    if (!previewDoc || !showPreview) return;
    const timer = setTimeout(() => {
      previewForm(previewDoc.document_id, own, version?.version.parent_version_id ?? null)
        .then(setPreview)
        .catch((err) => setError(err instanceof Error ? err.message : "Preview failed."));
    }, 500);
    return () => clearTimeout(timer);
  }, [own, previewDoc, showPreview, version]);

  // ---------------------------------------------------------------- workflow

  async function act(action: () => Promise<VersionDetail>) {
    try {
      const result = await action();
      router.replace(`/schemas/${schemaId}?version=${result.version.id}`);
      await load(result.version.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    }
  }

  async function addDiscovered(document: DocumentSummary) {
    try {
      const result = await discoverFields(document.document_id);
      change((draft) => {
        const taken = new Set(allFieldIds);
        const groupIds = new Set<string>();
        walk(effective.groups, (g) => groupIds.add(g.group_id));
        for (const group of result.definition.groups) {
          const fields = group.fields.filter((f) => !taken.has(f.field_id) && result.suggestions.find((s) => s.field_id === f.field_id)?.origin === "found");
          if (!fields.length) continue;
          fields.forEach((f) => taken.add(f.field_id));
          draft.groups.push({ ...group, group_id: uniqueId(group.group_id, groupIds), fields });
          groupIds.add(group.group_id);
        }
      });
      if (!previewDoc) setPreviewDoc(document);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Field Discovery failed.");
    }
  }

  // ---------------------------------------------------------------- render

  if (error && !schema) return <p className="p-6 text-sm text-danger" role="alert">{error}</p>;
  if (!schema || !version) return <p className="p-6 text-sm text-text-muted">Loading schema…</p>;

  const selectedField = selected?.kind === "field" ? (() => { let f: SchemaField | null = null; walk(effective.groups, (g) => { const x = g.fields.find((y) => y.field_id === selected.id); if (x) f = x; }); return f as SchemaField | null; })() : null;
  const selectedGroup = selected?.kind === "group" ? findGroup(effective.groups, selected.id) : null;
  const status = version.version.status;

  return (
    <div className="workspace-page flex w-full flex-col" data-testid="schema-designer">
      <header className="border-b border-border bg-surface px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/schemas" className="text-sm text-text-secondary hover:text-foreground">← Schemas</Link>
          <h1 className="ml-2 text-base font-semibold text-foreground">{schema.name}</h1>
          <select
            value={version.version.id}
            onChange={(e) => { router.replace(`/schemas/${schemaId}?version=${e.target.value}`); }}
            aria-label="Version"
            className="h-8 rounded-lg border border-border bg-background px-2 text-xs"
          >
            {schema.all_versions.map((v) => <option key={v.id} value={v.id}>v{v.version} · {STATUS_LABEL[v.status]}</option>)}
          </select>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[status]}`} data-testid="version-status">{STATUS_LABEL[status]}</span>
          {schema.is_system && <span className="rounded bg-surface-soft px-1.5 py-0.5 text-[11px] text-text-secondary">Built-in · read-only</span>}
          {version.version.parent && <span className="text-xs text-text-muted">inherits {version.version.parent}</span>}
          <span className="ml-auto text-xs text-text-muted" data-testid="save-state">
            {editable ? { saved: "All changes saved", saving: "Saving…", unsaved: "Unsaved changes", error: "Not saved" }[save] : "Read-only version"}
          </span>
          {editable && (
            <>
              <button type="button" onClick={undo} disabled={!past.length} aria-label="Undo" className="rounded-md p-1.5 text-text-secondary hover:bg-surface-soft disabled:opacity-40"><Undo2 className="h-4 w-4" /></button>
              <button type="button" onClick={redo} disabled={!future.length} aria-label="Redo" className="rounded-md p-1.5 text-text-secondary hover:bg-surface-soft disabled:opacity-40"><Redo2 className="h-4 w-4" /></button>
              <button type="button" onClick={() => void act(() => transition(schemaId, version.version.id, "submit"))} className="btn-secondary px-3 py-1.5 text-xs">Submit for review</button>
            </>
          )}
          {!schema.is_system && (status === "draft" || status === "in_review") && (
            <button type="button" onClick={() => void act(() => transition(schemaId, version.version.id, "publish"))} className="btn-primary px-3 py-1.5 text-xs">Publish</button>
          )}
          {status === "in_review" && (
            <button type="button" onClick={() => void act(() => transition(schemaId, version.version.id, "withdraw"))} className="btn-secondary px-3 py-1.5 text-xs">Back to draft</button>
          )}
          {!schema.is_system && !editable && status !== "in_review" && (
            <button type="button" onClick={() => void act(() => newDraft(schemaId))} className="btn-secondary px-3 py-1.5 text-xs">Edit as new draft</button>
          )}
          <button type="button" onClick={() => void exportSchema(schemaId, version.version.id)} aria-label="Export JSON" title="Export JSON" className="rounded-md p-1.5 text-text-secondary hover:bg-surface-soft"><Download className="h-4 w-4" /></button>
        </div>
        {(error || problems.length > 0) && (
          <div className="mt-2 space-y-0.5 text-xs" role="alert">
            {error && <p className="text-danger">{error}</p>}
            {problems.slice(0, 5).map((p) => <p key={p} className="text-warning">{p}</p>)}
          </div>
        )}
      </header>

      <div className="grid min-h-0 flex-1 xl:grid-cols-[13rem_minmax(0,1fr)_20rem]">
        {/* Palette */}
        <aside className="border-b border-border p-3 xl:border-b-0 xl:border-r" aria-label="Field palette">
          <Palette editable={editable} onAddField={addField} onAddGroup={addGroup} onDiscover={addDiscovered} />
        </aside>

        {/* Canvas + preview */}
        <main className="min-w-0 p-4">
          <div className="mb-3 flex items-center gap-2">
            <label className="relative flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" aria-hidden="true" />
              <input value={fieldQuery} onChange={(e) => setFieldQuery(e.target.value)} placeholder="Search fields…" aria-label="Search fields"
                className="h-8 w-full rounded-lg border border-border bg-background pl-7 pr-2 text-xs" />
            </label>
            <button type="button" onClick={() => setCollapsed(collapsed.size ? new Set() : new Set(effective.groups.map((g) => g.group_id)))} className="text-xs text-text-secondary hover:text-foreground">
              {collapsed.size ? "Expand all" : "Collapse all"}
            </button>
          </div>
          <div className="space-y-2" data-testid="schema-canvas">
            {effective.groups.length === 0 && (
              <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-text-muted">
                Add a group or a field from the palette, or use Field Discovery to start from a document.
              </p>
            )}
            {effective.groups.map((group) => (
              <GroupCard
                key={group.group_id}
                group={group}
                depth={0}
                query={fieldQuery.trim().toLowerCase()}
                editable={editable}
                own={ownGroupIds}
                inherited={inherited}
                collapsed={collapsed}
                selected={selected}
                onToggle={(id) => setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
                onSelect={setSelected}
                onRename={(fieldId, label) => updateField(fieldId, { label })}
                onMove={moveField}
                onReorder={reorder}
                onDropType={(type, groupId) => addField(type, groupId)}
                onRemove={removeField}
              />
            ))}
          </div>

          <section className="mt-5 rounded-xl border border-border bg-surface" aria-label="Live preview">
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
              <button type="button" onClick={() => setShowPreview((v) => !v)} className="text-xs font-semibold uppercase tracking-wide text-text-secondary" aria-expanded={showPreview}>
                Live preview
              </button>
              <DocumentPicker value={previewDoc} onChange={setPreviewDoc} />
              <div className="ml-auto flex items-center gap-1" role="radiogroup" aria-label="Device">
                {([["desktop", Monitor], ["tablet", Tablet], ["mobile", Smartphone]] as const).map(([id, Icon]) => (
                  <button key={id} type="button" role="radio" aria-checked={device === id} aria-label={id} onClick={() => setDevice(id)}
                    className={`rounded-md p-1 ${device === id ? "bg-primary/10 text-primary" : "text-text-secondary"}`}><Icon className="h-4 w-4" /></button>
                ))}
                <span className="mx-1 h-4 w-px bg-border" />
                {(["form", "table"] as const).map((id) => (
                  <button key={id} type="button" role="radio" aria-checked={layout === id} onClick={() => setLayout(id)}
                    className={`rounded-md px-2 py-0.5 text-xs ${layout === id ? "bg-primary/10 text-foreground" : "text-text-secondary"}`}>{id === "form" ? "Form" : "Table"}</button>
                ))}
              </div>
            </div>
            {showPreview && (
              <div className="overflow-x-auto bg-surface-soft/40 p-3">
                <div className="mx-auto rounded-lg border border-border bg-surface p-3 transition-[width]" style={{ width: DEVICE_WIDTH[device], maxWidth: "100%" }} data-testid="preview-frame">
                  {!previewDoc ? (
                    <p className="py-6 text-center text-xs text-text-muted">Choose a document to preview this schema with its real data.</p>
                  ) : preview ? (
                    <SchemaForm form={preview} layout={layout} />
                  ) : (
                    <p className="py-6 text-center text-xs text-text-muted">Building preview…</p>
                  )}
                </div>
              </div>
            )}
          </section>
        </main>

        {/* Inspector */}
        <aside className="border-t border-border xl:border-l xl:border-t-0" aria-label="Inspector">
          <div className="flex border-b border-border" role="tablist">
            {([["properties", "Properties"], ["rules", `Rules (${effective.rules.length})`], ["history", "History"]] as const).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={rightTab === id} onClick={() => setRightTab(id)}
                className={`flex-1 border-b-2 px-2 py-2 text-xs font-medium ${rightTab === id ? "border-primary text-foreground" : "border-transparent text-text-secondary"}`}>{label}</button>
            ))}
          </div>
          <div className="max-h-[78vh] overflow-y-auto p-3 text-sm">
            {rightTab === "properties" && (
              selectedField ? (
                <FieldProperties
                  key={selectedField.field_id}
                  field={selectedField}
                  inherited={inherited.has(selectedField.field_id)}
                  editable={editable}
                  allFieldIds={[...allFieldIds]}
                  onChange={(patch) => updateField(selectedField.field_id, patch)}
                  onRemove={() => removeField(selectedField.field_id)}
                />
              ) : selectedGroup ? (
                <GroupProperties
                  key={selectedGroup.group_id}
                  group={selectedGroup}
                  editable={editable && ownGroupIds.has(selectedGroup.group_id)}
                  onChange={(patch) => updateGroup(selectedGroup.group_id, patch)}
                  onRemove={() => removeGroup(selectedGroup.group_id)}
                />
              ) : (
                <p className="text-xs text-text-muted">Select a field or group to edit its properties.</p>
              )
            )}
            {rightTab === "rules" && (
              <RulesEditor
                rules={effective.rules}
                ownRuleIds={new Set(own.rules.map((r) => r.rule_id))}
                fieldIds={[...allFieldIds]}
                editable={editable}
                onAdd={(rule) => change((d) => { d.rules.push(rule); })}
                onRemove={(id) => change((d) => { d.rules = d.rules.filter((r) => r.rule_id !== id); })}
              />
            )}
            {rightTab === "history" && (
              <div className="space-y-3 text-xs">
                <p className="text-text-secondary">
                  Versioning: <strong>major.minor</strong>. Published versions never change; editing one starts a new draft.
                  Documents keep their version until migrated.
                </p>
                <ul className="space-y-1" data-testid="version-list">
                  {schema.all_versions.map((v) => (
                    <li key={v.id} className="flex items-center justify-between gap-2">
                      <button type="button" onClick={() => router.replace(`/schemas/${schemaId}?version=${v.id}`)} className="text-left text-foreground hover:text-primary">v{v.version}</button>
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${STATUS_TONE[v.status]}`}>{STATUS_LABEL[v.status]}</span>
                      <span className="text-text-muted">{v.documents} docs</span>
                    </li>
                  ))}
                </ul>
                <ol className="space-y-1 border-t border-border pt-2">
                  <li className="flex items-center gap-1 font-medium text-text-secondary"><History className="h-3.5 w-3.5" /> Audit trail</li>
                  {schema.events.slice(0, 30).map((e, i) => (
                    <li key={i} className="text-text-secondary"><span className="text-text-muted">{new Date(e.at).toLocaleString()}</span> · {e.action.replace("_", " ")} by {e.actor}</li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- pieces

function Palette({ editable, onAddField, onAddGroup, onDiscover }: {
  editable: boolean;
  onAddField: (type: FieldType) => void;
  onAddGroup: (kind: GroupKind) => void;
  onDiscover: (doc: DocumentSummary) => void;
}) {
  const [query, setQuery] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const needle = query.trim().toLowerCase();
  return (
    <div className="space-y-3">
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search components…" aria-label="Search components"
        className="h-8 w-full rounded-lg border border-border bg-background px-2 text-xs" />
      <div>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Groups</p>
        {GROUP_PALETTE.filter((g) => !needle || g.label.toLowerCase().includes(needle)).map((g) => (
          <button key={g.kind} type="button" disabled={!editable} onClick={() => onAddGroup(g.kind)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground hover:bg-surface-soft disabled:opacity-40">
            <g.icon className="h-3.5 w-3.5 text-text-secondary" aria-hidden="true" />{g.label}
          </button>
        ))}
      </div>
      <div>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Fields</p>
        <ul data-testid="field-palette">
          {PALETTE.filter((p) => !needle || p.label.toLowerCase().includes(needle)).map((p) => (
            <li key={p.type}>
              <button
                type="button"
                disabled={!editable}
                draggable={editable}
                onDragStart={(e) => e.dataTransfer.setData("application/x-field-type", p.type)}
                onClick={() => onAddField(p.type)}
                title="Click to add to the selected group, or drag onto a group"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground hover:bg-surface-soft disabled:opacity-40"
              >
                <p.icon className="h-3.5 w-3.5 text-text-secondary" aria-hidden="true" />{p.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="border-t border-border pt-3">
        <button type="button" disabled={!editable} onClick={() => setDiscovering((v) => !v)} className="btn-secondary w-full justify-center px-2 py-1.5 text-xs disabled:opacity-40">
          <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />Field Discovery
        </button>
        {discovering && (
          <div className="mt-2">
            <p className="mb-1 text-[11px] text-text-secondary">Adds the fields and tables found in a document (values are not copied).</p>
            <DocumentPicker value={null} onChange={(d) => { if (d) { onDiscover(d); setDiscovering(false); } }} />
          </div>
        )}
      </div>
    </div>
  );
}

function GroupCard(props: {
  group: SchemaGroup;
  depth: number;
  query: string;
  editable: boolean;
  own: Set<string>;
  inherited: Set<string>;
  collapsed: Set<string>;
  selected: Selection;
  onToggle: (id: string) => void;
  onSelect: (s: Selection) => void;
  onRename: (fieldId: string, label: string) => void;
  onMove: (fieldId: string, toGroup: string, beforeId: string | null) => void;
  onReorder: (groupId: string, ids: string[]) => void;
  onDropType: (type: FieldType, groupId: string) => void;
  onRemove: (fieldId: string) => void;
}) {
  const { group, query, editable, collapsed, selected } = props;
  const [over, setOver] = useState(false);
  const fields = group.fields.filter((f) => !query || `${f.label} ${f.field_id}`.toLowerCase().includes(query));
  const isCollapsed = collapsed.has(group.group_id);
  const onDrop = (e: React.DragEvent, beforeId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(false);
    const type = e.dataTransfer.getData("application/x-field-type") as FieldType;
    const fieldId = e.dataTransfer.getData("application/x-field-id");
    if (type) props.onDropType(type, group.group_id);
    else if (fieldId) props.onMove(fieldId, group.group_id, beforeId);
  };
  const move = (index: number, delta: number) => {
    const ids = group.fields.map((f) => f.field_id);
    const [id] = ids.splice(index, 1);
    ids.splice(Math.max(0, Math.min(ids.length, index + delta)), 0, id);
    props.onReorder(group.group_id, ids);
  };
  return (
    <div
      className={`rounded-xl border bg-surface ${selected?.kind === "group" && selected.id === group.group_id ? "border-primary/50" : "border-border"} ${over ? "ring-2 ring-primary/30" : ""}`}
      style={{ marginLeft: props.depth * 16 }}
      onDragOver={(e) => { if (editable) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => onDrop(e, null)}
      data-testid="schema-group"
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" onClick={() => props.onToggle(group.group_id)} aria-label={isCollapsed ? "Expand group" : "Collapse group"} className="text-text-muted">
          {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        <button type="button" onClick={() => props.onSelect({ kind: "group", id: group.group_id })} className="flex-1 text-left">
          <span className="text-sm font-semibold text-foreground">{group.label}</span>
          <span className="ml-2 text-[11px] text-text-muted">
            {group.kind === "repeating" ? "table" : group.kind} · {group.fields.length} fields
            {!props.own.has(group.group_id) && " · inherited"}
          </span>
        </button>
      </div>
      {!isCollapsed && (
        <ul className="border-t border-border/70">
          {fields.map((field, index) => {
            const isInherited = props.inherited.has(field.field_id);
            const active = selected?.kind === "field" && selected.id === field.field_id;
            return (
              <li
                key={field.field_id}
                draggable={editable}
                onDragStart={(e) => e.dataTransfer.setData("application/x-field-id", field.field_id)}
                onDragOver={(e) => { if (editable) e.preventDefault(); }}
                onDrop={(e) => onDrop(e, field.field_id)}
                onClick={() => props.onSelect({ kind: "field", id: field.field_id })}
                className={`group flex items-center gap-2 border-b border-border/50 px-3 py-1.5 last:border-b-0 ${active ? "bg-primary/[0.06]" : "hover:bg-surface-soft"} ${field.visible === false ? "opacity-50" : ""}`}
                data-testid="schema-field"
              >
                {editable && <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-text-muted" aria-hidden="true" />}
                <input
                  value={field.label}
                  readOnly={!editable}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => props.onRename(field.field_id, e.target.value)}
                  aria-label={`Label for ${field.field_id}`}
                  className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-[13px] text-foreground hover:border-border focus:border-primary/40 focus:outline-none"
                />
                <span className="hidden font-mono text-[10px] text-text-muted sm:inline">{field.field_id}</span>
                <span className="rounded bg-surface-soft px-1 text-[10px] text-text-secondary">{field.type}</span>
                {field.required && <span className="text-[10px] font-medium text-danger">required</span>}
                {isInherited && <span className="text-[10px] text-text-muted" title="Inherited from the parent schema">inherited</span>}
                {field.visible === false && <EyeOff className="h-3 w-3 text-text-muted" aria-label="hidden" />}
                {editable && (
                  <span className="flex items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                    <button type="button" aria-label={`Move ${field.label} up`} disabled={index === 0} onClick={(e) => { e.stopPropagation(); move(index, -1); }} className="p-0.5 text-text-muted hover:text-foreground disabled:opacity-30"><ArrowUp className="h-3 w-3" /></button>
                    <button type="button" aria-label={`Move ${field.label} down`} disabled={index === fields.length - 1} onClick={(e) => { e.stopPropagation(); move(index, 1); }} className="p-0.5 text-text-muted hover:text-foreground disabled:opacity-30"><ArrowDown className="h-3 w-3" /></button>
                    <button type="button" aria-label={isInherited ? `Hide ${field.label}` : `Remove ${field.label}`} onClick={(e) => { e.stopPropagation(); props.onRemove(field.field_id); }} className="p-0.5 text-text-muted hover:text-danger">
                      {isInherited ? <EyeOff className="h-3 w-3" /> : <Trash2 className="h-3 w-3" />}
                    </button>
                  </span>
                )}
              </li>
            );
          })}
          {fields.length === 0 && <li className="px-3 py-3 text-xs text-text-muted">{query ? "No matching fields." : "Drop fields here."}</li>}
        </ul>
      )}
      {!isCollapsed && group.children.map((child) => <GroupCard key={child.group_id} {...props} group={child} depth={props.depth + 1} />)}
    </div>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-[11px] font-medium text-text-secondary">{label}<div className="mt-0.5">{children}</div></label>;
}

const INPUT = "h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground disabled:bg-surface-soft disabled:text-text-secondary";

function FieldProperties({ field, inherited, editable, allFieldIds, onChange, onRemove }: {
  field: SchemaField;
  inherited: boolean;
  editable: boolean;
  allFieldIds: string[];
  onChange: (patch: Partial<SchemaField>) => void;
  onRemove: () => void;
}) {
  const structural = editable && !inherited;
  const [fieldId, setFieldId] = useState(field.field_id);
  return (
    <div className="space-y-2.5" data-testid="field-properties">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Field configuration{inherited ? " · inherited" : ""}</p>
      <Labelled label="Canonical field identifier">
        <input value={fieldId} disabled={!structural} className={`${INPUT} font-mono`}
          onChange={(e) => setFieldId(e.target.value)}
          onBlur={() => { if (fieldId !== field.field_id && /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/.test(fieldId) && !allFieldIds.includes(fieldId)) onChange({ field_id: fieldId }); else setFieldId(field.field_id); }} />
        <span className="mt-0.5 block text-[10px] text-text-muted">Stable id used by mappings and exports; labels can change freely.</span>
      </Labelled>
      <Labelled label="Display label"><input value={field.label} disabled={!editable} onChange={(e) => onChange({ label: e.target.value })} className={INPUT} /></Labelled>
      <Labelled label="Description"><input value={field.description ?? ""} disabled={!editable} onChange={(e) => onChange({ description: e.target.value || null })} className={INPUT} /></Labelled>
      <Labelled label="Data type">
        <select value={field.type} disabled={!structural} onChange={(e) => onChange({ type: e.target.value as FieldType })} className={INPUT}>
          {PALETTE.map((p) => <option key={p.type} value={p.type}>{p.label}</option>)}
        </select>
      </Labelled>
      <div className="flex gap-3 text-xs">
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={Boolean(field.required)} disabled={!editable} onChange={(e) => onChange({ required: e.target.checked })} />Required</label>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={field.visible !== false} disabled={!editable} onChange={(e) => onChange({ visible: e.target.checked })} />Visible</label>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={field.evidence_required !== false} disabled={!structural} onChange={(e) => onChange({ evidence_required: e.target.checked })} />Evidence</label>
      </div>
      <Labelled label="Default value"><input value={field.default ?? ""} disabled={!structural} onChange={(e) => onChange({ default: e.target.value || null })} className={INPUT} /></Labelled>
      <Labelled label="Allowed values (comma separated)">
        <input value={(field.allowed_values ?? []).join(", ")} disabled={!editable} onChange={(e) => onChange({ allowed_values: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) })} className={INPUT} />
      </Labelled>
      <Labelled label="Extraction instructions">
        <textarea value={field.instructions ?? ""} disabled={!editable} rows={3} onChange={(e) => onChange({ instructions: e.target.value || null })}
          className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs disabled:bg-surface-soft" placeholder="e.g. Identify the official contract or award number. Preserve its original format." />
        <span className="block text-[10px] text-text-muted">Guidance text only — never treated as a command.</span>
      </Labelled>
      <Labelled label="Normalization">
        <select value={field.normalization ?? "none"} disabled={!editable} onChange={(e) => onChange({ normalization: e.target.value as SchemaField["normalization"] })} className={INPUT}>
          {["none", "trim", "upper", "lower", "date_iso", "number"].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </Labelled>
      <Labelled label="Confidence threshold (0–1)">
        <input type="number" min={0} max={1} step={0.05} value={field.confidence_threshold ?? ""} disabled={!editable}
          onChange={(e) => onChange({ confidence_threshold: e.target.value === "" ? null : Number(e.target.value) })} className={INPUT} />
      </Labelled>
      {field.type === "calculated" && (
        <Labelled label="Calculation">
          <div className="flex gap-1">
            <select value={field.calculation?.op ?? "add"} disabled={!structural} onChange={(e) => onChange({ calculation: { op: e.target.value as "add", args: field.calculation?.args ?? [] } })} className={`${INPUT} w-24`}>
              {["sum", "add", "subtract", "multiply"].map((op) => <option key={op} value={op}>{op}</option>)}
            </select>
            <input value={(field.calculation?.args ?? []).join(", ")} disabled={!structural} placeholder="field ids"
              onChange={(e) => onChange({ calculation: { op: field.calculation?.op ?? "add", args: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) } })} className={INPUT} />
          </div>
        </Labelled>
      )}
      <Labelled label="Extracted data binding">
        <p className="rounded-md bg-surface-soft px-2 py-1.5 font-mono text-[10px] text-text-secondary">
          {field.source?.kind === "field" ? `${field.source.dataset_id} · ${field.source.pair_key ?? field.source.field}` : "Not bound — found by its label in each document"}
        </p>
      </Labelled>
      <Labelled label="External mapping references">
        <p className="text-[10px] text-text-muted">Shown only where a saved Oracle mapping uses this field (Mapping Studio); none are assumed.</p>
      </Labelled>
      {editable && (
        <button type="button" onClick={onRemove} className="text-xs text-danger hover:underline">{inherited ? "Hide inherited field" : "Remove field"}</button>
      )}
    </div>
  );
}

function GroupProperties({ group, editable, onChange, onRemove }: {
  group: SchemaGroup;
  editable: boolean;
  onChange: (patch: Partial<SchemaGroup>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="space-y-2.5" data-testid="group-properties">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Group{editable ? "" : " · inherited (read-only)"}</p>
      <Labelled label="Label"><input value={group.label} disabled={!editable} onChange={(e) => onChange({ label: e.target.value })} className={INPUT} /></Labelled>
      <Labelled label="Kind">
        <select value={group.kind} disabled={!editable} onChange={(e) => onChange({ kind: e.target.value as GroupKind })} className={INPUT}>
          {GROUP_PALETTE.map((g) => <option key={g.kind} value={g.kind}>{g.label}</option>)}
        </select>
      </Labelled>
      <Labelled label="Description"><input value={group.description ?? ""} disabled={!editable} onChange={(e) => onChange({ description: e.target.value || null })} className={INPUT} /></Labelled>
      {group.kind === "repeating" && (
        <>
          <Labelled label="Rows come from extracted table"><input value={group.source_dataset ?? ""} disabled={!editable} placeholder="e.g. line_items" onChange={(e) => onChange({ source_dataset: e.target.value || null })} className={`${INPUT} font-mono`} /></Labelled>
          <Labelled label="Row key field">
            <select value={group.key_field ?? ""} disabled={!editable} onChange={(e) => onChange({ key_field: e.target.value || null })} className={INPUT}>
              <option value="">—</option>
              {group.fields.map((f) => <option key={f.field_id} value={f.field_id}>{f.label}</option>)}
            </select>
          </Labelled>
          <Labelled label="Parent key field (nested tables)">
            <select value={group.parent_key_field ?? ""} disabled={!editable} onChange={(e) => onChange({ parent_key_field: e.target.value || null })} className={INPUT}>
              <option value="">—</option>
              {group.fields.map((f) => <option key={f.field_id} value={f.field_id}>{f.label}</option>)}
            </select>
          </Labelled>
          <Labelled label="Rows per page"><input type="number" min={5} max={500} value={group.page_size ?? 25} disabled={!editable} onChange={(e) => onChange({ page_size: Number(e.target.value) || 25 })} className={INPUT} /></Labelled>
        </>
      )}
      {editable && <button type="button" onClick={onRemove} className="text-xs text-danger hover:underline">Remove group</button>}
    </div>
  );
}

function RulesEditor({ rules, ownRuleIds, fieldIds, editable, onAdd, onRemove }: {
  rules: SchemaRule[];
  ownRuleIds: Set<string>;
  fieldIds: string[];
  editable: boolean;
  onAdd: (rule: SchemaRule) => void;
  onRemove: (id: string) => void;
}) {
  const [kind, setKind] = useState<RuleKind>("required");
  const [fields, setFields] = useState<string[]>([]);
  const [param, setParam] = useState("");
  const [param2, setParam2] = useState("");
  const [severity, setSeverity] = useState<"error" | "warning">("error");

  function build(): SchemaRule | null {
    if (!fields.length) return null;
    const params: SchemaRule["params"] = {};
    if (kind === "pattern") params.pattern = param;
    if (kind === "range") { if (param) params.min = Number(param); if (param2) params.max = Number(param2); }
    if (kind === "allowed_values") params.values = param.split(",").map((v) => v.trim()).filter(Boolean);
    if (kind === "sum_matches") params.tolerance = Number(param || 0.01);
    if (kind === "conditional_required") { params.when_field = param; if (param2) params.when_value = param2; }
    const taken = new Set(rules.map((r) => r.rule_id));
    return { rule_id: uniqueId(`${kind}_${fields[0].split(".").pop()}`, taken), kind, fields, params, severity };
  }

  return (
    <div className="space-y-3 text-xs" data-testid="rules-editor">
      <ul className="space-y-1">
        {rules.map((rule) => (
          <li key={rule.rule_id} className="flex items-start justify-between gap-2 rounded-md border border-border px-2 py-1.5">
            <span>
              <span className="font-medium text-foreground">{RULE_KINDS.find((r) => r.kind === rule.kind)?.label}</span>
              <span className="block font-mono text-[10px] text-text-secondary">{rule.fields.join(" → ")}{Object.keys(rule.params).length ? ` · ${JSON.stringify(rule.params)}` : ""}</span>
              {!ownRuleIds.has(rule.rule_id) && <span className="text-[10px] text-text-muted">inherited</span>}
            </span>
            {editable && ownRuleIds.has(rule.rule_id) && <button type="button" aria-label={`Remove rule ${rule.rule_id}`} onClick={() => onRemove(rule.rule_id)} className="text-text-muted hover:text-danger"><Trash2 className="h-3 w-3" /></button>}
          </li>
        ))}
        {rules.length === 0 && <li className="text-text-muted">No rules yet. Rules report problems; they never change extracted values.</li>}
      </ul>
      {editable && (
        <div className="space-y-2 rounded-md border border-border p-2">
          <select value={kind} onChange={(e) => setKind(e.target.value as RuleKind)} aria-label="Rule kind" className={INPUT}>
            {RULE_KINDS.map((r) => <option key={r.kind} value={r.kind}>{r.label}</option>)}
          </select>
          <select multiple value={fields} onChange={(e) => setFields([...e.target.selectedOptions].map((o) => o.value))} aria-label="Rule fields" className="h-24 w-full rounded-md border border-border bg-background text-xs">
            {fieldIds.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
          {kind !== "required" && kind !== "date_order" && (
            <input value={param} onChange={(e) => setParam(e.target.value)} aria-label="Rule parameter" className={INPUT}
              placeholder={{ pattern: "Regular expression", range: "Minimum", allowed_values: "Values, comma separated", sum_matches: "Tolerance (0.01)", conditional_required: "When field id" }[kind as string] ?? ""} />
          )}
          {(kind === "range" || kind === "conditional_required") && (
            <input value={param2} onChange={(e) => setParam2(e.target.value)} aria-label="Second rule parameter" className={INPUT} placeholder={kind === "range" ? "Maximum" : "When value (optional)"} />
          )}
          <div className="flex items-center gap-2">
            <select value={severity} onChange={(e) => setSeverity(e.target.value as "error" | "warning")} aria-label="Severity" className={`${INPUT} w-28`}>
              <option value="error">Error</option>
              <option value="warning">Warning</option>
            </select>
            <button type="button" onClick={() => { const rule = build(); if (rule) { onAdd(rule); setFields([]); setParam(""); setParam2(""); } }}
              disabled={!fields.length} className="btn-secondary px-2 py-1 text-xs disabled:opacity-50">
              <Plus className="h-3 w-3" aria-hidden="true" />Add rule
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function DocumentPicker({ value, onChange }: { value: DocumentSummary | null; onChange: (d: DocumentSummary | null) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [docs, setDocs] = useState<DocumentSummary[]>([]);
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      searchDocuments({ q: query.trim() || undefined, limit: 15 }).then((r) => setDocs(r.documents.filter((d) => d.staging_status === "staged"))).catch(() => setDocs([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [open, query]);
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} className="h-7 max-w-[16rem] truncate rounded-md border border-border bg-background px-2 text-xs text-foreground" aria-haspopup="listbox" aria-expanded={open}>
        {value ? value.original_filename : "Choose a document…"}
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-1 w-72 rounded-lg border border-border bg-surface p-2 shadow-lg">
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search documents…" aria-label="Search preview documents" className={INPUT} />
          <ul className="mt-1 max-h-60 overflow-y-auto" role="listbox">
            {docs.map((d) => (
              <li key={d.document_id}>
                <button type="button" onClick={() => { onChange(d); setOpen(false); }} className="w-full truncate rounded px-2 py-1.5 text-left text-xs hover:bg-surface-soft">
                  {d.original_filename}<span className="ml-1 text-text-muted">{d.type_label}</span>
                </button>
              </li>
            ))}
            {docs.length === 0 && <li className="px-2 py-2 text-xs text-text-muted">No extracted documents.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
