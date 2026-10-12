"use client";

import { ArrowRight, Loader2, Save, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { PIPELINE_STAGE_LABELS } from "@/components/extraction-live-progress";
import ExtractionInstruction from "@/components/extraction/extraction-instruction";
import SuggestedExtraction from "@/components/extraction/suggested-extraction";
import TargetPicker, {
  type CustomQuickPick,
} from "@/components/extraction/target-picker";
import {
  addExtractionField,
  createExtractionModel,
  listExtractionModels,
} from "@/lib/extraction-models";
import { resolveSuggestionGroups } from "@/lib/suggestion-groups";
import type {
  DocumentTarget,
  ExtractionJob,
  ExtractionModel,
  ExtractTargetsResult,
  TargetType,
  UniversalExtractionResult,
} from "@/types/document";

const STAGE_LABELS: Record<string, string> = {
  extracting_data: "Extracting selected fields…",
  validating_results: "Validating results…",
  complete: "Finishing up…",
};

function extractionStageLabel(job: ExtractionJob | null | undefined): string {
  if (!job) return "Running extraction against detected document schema...";
  if (job.status === "queued") return "Queued…";
  if (job.stage && STAGE_LABELS[job.stage]) return STAGE_LABELS[job.stage];
  return "Running extraction against detected document schema...";
}

interface AnalysisRequestProps {
  disabled?: boolean;
  waking?: boolean;
  extractionJob?: ExtractionJob | null;
  targets?: DocumentTarget[];
  documentFamily?: string | null;
  documentFamilyLabel?: string | null;
  documentFamilyConfidence?: number | null;
  schemaDiscovering?: boolean;
  schemaDiscoveryError?: string;
  /** True while pages/OCR/indexing are still running (not schema discovery). */
  documentProcessing?: boolean;
  pipelineStage?: string | null;
  onRetryDiscovery?: () => void;

  onExtractTargets: (
    targetIds: string[],
  ) => Promise<ExtractTargetsResult>;

  onAnalyze: (
    instruction: string,
  ) => Promise<UniversalExtractionResult>;

  onAddCustomField?: (label: string) => Promise<DocumentTarget | undefined>;
  onRenameCustomField?: (targetKey: string, label: string) => Promise<void>;
  onDeleteCustomField?: (targetKey: string) => Promise<void>;
  /** The document's page, offered when nothing is pickable. */
  documentHref?: string;
}

const CUSTOM_QUICK_PICKS: CustomQuickPick[] = [
  {
    key: "custom_instruction",
    label: "Custom Extraction…",
    prompt: "",
  },
];

function schemaPanelHeading(
  family: string | null | undefined,
  familyLabel: string | null | undefined,
): { title: string; subtitle: string; description: string } {
  const key = family ?? "";
  if (key === "xml_data" || /xml|clause xml/i.test(familyLabel ?? "")) {
    return {
      title: "Schema & Extraction",
      subtitle: "Clause and provision fields",
      description:
        "Fields come from this XML document’s schema. Unrelated invoice or contract presets are not shown.",
    };
  }
  if (key === "far_regulation" || key === "far_regulatory_change") {
    return {
      title: "Schema & Extraction",
      subtitle: "Regulatory structure",
      description:
        "Suggestions follow the FAR document’s detected sections and fields — not generic business templates.",
    };
  }
  if (key === "invoice") {
    return {
      title: "Schema & Extraction",
      subtitle: "Invoice fields and line items",
      description:
        "Pick supplier, amounts, and line items discovered in this invoice.",
    };
  }
  if (key === "academic_transcript") {
    return {
      title: "Schema & Extraction",
      subtitle: "Student and course fields",
      description:
        "Suggestions follow this transcript’s detected schema.",
    };
  }
  if (key === "government_contract") {
    return {
      title: "Schema & Extraction",
      subtitle: "Contract fields and tables",
      description:
        "Suggestions follow this contract’s detected schema — not static presets.",
    };
  }
  return {
    title: "Schema & Extraction",
    subtitle: "What do you want to extract?",
    description:
      "Suggestions follow this document’s detected schema — not static presets or unrelated saved models.",
  };
}

export default function AnalysisRequest({
  disabled = false,
  waking = false,
  extractionJob = null,
  targets = [],
  documentFamily = null,
  documentFamilyLabel = null,
  documentFamilyConfidence = null,
  schemaDiscovering = false,
  schemaDiscoveryError = "",
  documentProcessing = false,
  pipelineStage = null,
  onRetryDiscovery,
  onExtractTargets,
  onAnalyze,
  onAddCustomField,
  onRenameCustomField,
  onDeleteCustomField,
  documentHref,
}: AnalysisRequestProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState("");
  const [noMatch, setNoMatch] = useState(false);
  const [didApplyDefaults, setDidApplyDefaults] = useState(false);

  const [instruction, setInstruction] = useState("");
  const [instructionExpanded, setInstructionExpanded] = useState(false);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState("");

  const [savingSchema, setSavingSchema] = useState(false);
  const [saveSchemaName, setSaveSchemaName] = useState("");
  const [schemaActionError, setSchemaActionError] = useState("");
  const [schemaActionBusy, setSchemaActionBusy] = useState(false);
  const [savedModels, setSavedModels] = useState<ExtractionModel[] | null>(
    null,
  );
  const [loadingModels, setLoadingModels] = useState(false);

  const busy = disabled || extracting || asking;

  const suggestionGroups = useMemo(
    () => resolveSuggestionGroups(documentFamily, targets),
    [documentFamily, targets],
  );

  const fieldTargets = useMemo(
    () => targets.filter((t) => t.target_type !== "table"),
    [targets],
  );
  const tableTargets = useMemo(
    () => targets.filter((t) => t.target_type === "table"),
    [targets],
  );

  useEffect(() => {
    setDidApplyDefaults(false);
    setSelectedIds(new Set());
  }, [documentFamily, targets.length]);

  useEffect(() => {
    if (didApplyDefaults || suggestionGroups.length === 0) return;
    const next = new Set<string>();
    for (const group of suggestionGroups) {
      if (group.defaultSelected) {
        for (const id of group.targetIds) next.add(id);
      }
    }
    if (next.size > 0) {
      setSelectedIds(next);
    }
    setDidApplyDefaults(true);
  }, [suggestionGroups, didApplyDefaults]);

  async function saveCurrentSelectionAsSchema() {
    if (!saveSchemaName.trim() || selectedIds.size === 0) return;

    setSchemaActionBusy(true);
    setSchemaActionError("");

    try {
      const model = await createExtractionModel(
        saveSchemaName.trim(),
        `Saved from Extraction Workspace (${selectedIds.size} fields)`,
        documentFamily ? [documentFamily] : ["*"],
      );

      const selectedTargets = targets.filter((target) =>
        selectedIds.has(target.id),
      );

      for (const target of selectedTargets) {
        await addExtractionField(model.id, target.label, "", "text");
      }

      setSavingSchema(false);
      setSaveSchemaName("");
    } catch (error) {
      setSchemaActionError(
        error instanceof Error ? error.message : "Couldn't save schema.",
      );
    } finally {
      setSchemaActionBusy(false);
    }
  }

  async function openLoadSchema() {
    setSchemaActionError("");
    setLoadingModels(true);

    try {
      const models = await listExtractionModels(documentFamily ?? undefined);
      setSavedModels(models);
    } catch (error) {
      setSchemaActionError(
        error instanceof Error ? error.message : "Couldn't load schemas.",
      );
    } finally {
      setLoadingModels(false);
    }
  }

  async function applySchema(model: ExtractionModel) {
    setSchemaActionBusy(true);
    setSchemaActionError("");

    try {
      const nextSelected = new Set(selectedIds);

      for (const field of model.fields) {
        const match = targets.find(
          (target) =>
            target.label.toLowerCase() === field.field_name.toLowerCase(),
        );

        if (match) {
          nextSelected.add(match.id);
          continue;
        }

        if (onAddCustomField) {
          const created = await onAddCustomField(field.field_name);
          if (created) {
            nextSelected.add(created.id);
          }
        }
      }

      setSelectedIds(nextSelected);
      setSavedModels(null);
    } catch (error) {
      setSchemaActionError(
        error instanceof Error ? error.message : "Couldn't apply schema.",
      );
    } finally {
      setSchemaActionBusy(false);
    }
  }

  function toggleTarget(targetId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(targetId)) {
        next.delete(targetId);
      } else {
        next.add(targetId);
      }
      return next;
    });
    setNoMatch(false);
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  async function runExtraction(targetIds: string[]) {
    if (targetIds.length === 0) return;

    setExtracting(true);
    setExtractError("");
    setNoMatch(false);

    try {
      const result = await onExtractTargets(targetIds);
      if (
        !result ||
        !Array.isArray(result.scalars) ||
        !Array.isArray(result.tables)
      ) {
        setExtractError(
          "Extraction finished without a usable result. Try a smaller selection.",
        );
        return;
      }
      if (result.scalars.length === 0 && result.tables.length === 0) {
        setNoMatch(true);
      }
    } catch (error) {
      setExtractError(
        error instanceof Error ? error.message : "Extraction failed.",
      );
    } finally {
      setExtracting(false);
    }
  }

  function selectAllOfType(targetType: TargetType) {
    const ids = targets
      .filter((target) =>
        targetType === "field"
          ? target.target_type !== "table"
          : target.target_type === targetType,
      )
      .map((target) => target.id);

    if (ids.length === 0) return;
    setSelectedIds(new Set(ids));
    setNoMatch(false);
  }

  function selectAllVisible(targetIds: string[]) {
    if (targetIds.length === 0) return;
    setSelectedIds(new Set(targetIds));
    setNoMatch(false);
  }

  function toggleGroup(targetIds: string[]) {
    setSelectedIds((current) => {
      const allSelected = targetIds.every((id) => current.has(id));
      const next = new Set(current);
      for (const id of targetIds) {
        if (allSelected) {
          next.delete(id);
        } else {
          next.add(id);
        }
      }
      return next;
    });
    setNoMatch(false);
  }

  function selectCustomQuickPick(pick: CustomQuickPick) {
    setInstruction(pick.prompt);
    setInstructionExpanded(true);
  }

  async function askQuestion() {
    if (!instruction.trim()) return;

    setAsking(true);
    setAskError("");

    try {
      await onAnalyze(instruction.trim());
    } catch (error) {
      setAskError(
        error instanceof Error ? error.message : "Analysis failed.",
      );
    } finally {
      setAsking(false);
    }
  }

  const allFieldsSelected =
    fieldTargets.length > 0 &&
    fieldTargets.every((t) => selectedIds.has(t.id));
  const allTablesSelected =
    tableTargets.length > 0 &&
    tableTargets.every((t) => selectedIds.has(t.id));

  const schemaHeading = schemaPanelHeading(documentFamily, documentFamilyLabel);
  const classificationUnresolved =
    !documentFamilyLabel ||
    documentFamily === "unknown" ||
    documentFamily === null;

  return (
    <div className="editorial-card p-6 sm:p-8" data-testid="schema-extraction-panel">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10" aria-hidden="true">
          <Search className="h-5 w-5 text-primary" strokeWidth={1.75} />
        </div>

        <div className="min-w-0">
          <h2 className="text-lg font-medium text-foreground">{schemaHeading.title}</h2>
          <p className="mt-0.5 text-base font-medium text-foreground">
            {schemaHeading.subtitle}
          </p>
          <p className="mt-1 text-sm leading-6 text-text-secondary">
            {schemaHeading.description}
          </p>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-border bg-surface-soft/60 px-4 py-3" data-testid="detected-document">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Detected document
        </p>
        <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2">
          <p
            className={
              classificationUnresolved
                ? "text-sm font-semibold text-warning"
                : "text-sm font-semibold text-foreground"
            }
          >
            {classificationUnresolved
              ? "Classification unresolved"
              : documentFamilyLabel}
          </p>
          {typeof documentFamilyConfidence === "number" && !classificationUnresolved && (
            <p className="text-xs font-medium text-text-secondary">
              {Math.round(documentFamilyConfidence * 100)}% confidence
            </p>
          )}
        </div>
        {classificationUnresolved && (
          <p className="mt-1 text-xs text-text-secondary">
            Schema suggestions stay limited until the document type is resolved.
            Classification is never taken from the filename alone.
          </p>
        )}
      </div>

      <div className="mt-5 space-y-4">
        {schemaDiscovering || documentProcessing ? (
          <div
            className="space-y-3 rounded-xl border border-border bg-surface-soft px-4 py-5"
            role="status"
            aria-live="polite"
            aria-busy="true"
          >
            <div className="flex items-center gap-2 text-sm text-text-secondary">
              <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
              {waking
                ? "Connecting to processing service…"
                : schemaDiscovering
                  ? "Discovering schema…"
                  : pipelineStage && PIPELINE_STAGE_LABELS[pipelineStage]
                    ? `${PIPELINE_STAGE_LABELS[pipelineStage]}…`
                    : "Processing document pages…"}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {Array.from({ length: 6 }).map((_, index) => (
                <div
                  key={index}
                  className="h-10 animate-pulse rounded-lg border border-border/70 bg-surface"
                />
              ))}
            </div>
          </div>
        ) : schemaDiscoveryError ? (
          <div className="space-y-3 rounded-xl border border-danger/20 bg-danger/5 p-4">
            <p className="text-sm font-medium text-danger">
              Couldn&apos;t discover this document&apos;s schema
            </p>
            <p className="text-sm leading-6 text-danger/80">
              {schemaDiscoveryError}
            </p>
            {onRetryDiscovery && (
              <button
                type="button"
                onClick={onRetryDiscovery}
                className="btn-secondary text-sm"
              >
                Retry
              </button>
            )}
          </div>
        ) : (
          <>
            <SuggestedExtraction
              groups={suggestionGroups}
              selectedIds={selectedIds}
              disabled={busy}
              onToggleGroup={toggleGroup}
              fieldCount={fieldTargets.length}
              tableCount={tableTargets.length}
              allFieldsSelected={allFieldsSelected}
              allTablesSelected={allTablesSelected}
              onSelectAllFields={() => {
                if (allFieldsSelected) {
                  setSelectedIds((current) => {
                    const next = new Set(current);
                    for (const t of fieldTargets) next.delete(t.id);
                    return next;
                  });
                } else {
                  setSelectedIds((current) => {
                    const next = new Set(current);
                    for (const t of fieldTargets) next.add(t.id);
                    return next;
                  });
                }
                setNoMatch(false);
              }}
              onSelectAllTables={() => {
                if (allTablesSelected) {
                  setSelectedIds((current) => {
                    const next = new Set(current);
                    for (const t of tableTargets) next.delete(t.id);
                    return next;
                  });
                } else {
                  setSelectedIds((current) => {
                    const next = new Set(current);
                    for (const t of tableTargets) next.add(t.id);
                    return next;
                  });
                }
                setNoMatch(false);
              }}
            />

            <TargetPicker
              targets={targets}
              customQuickPicks={CUSTOM_QUICK_PICKS}
              selectedIds={selectedIds}
              disabled={busy}
              onToggle={toggleTarget}
              onToggleGroup={toggleGroup}
              onSelectAll={selectAllOfType}
              onSelectAllVisible={selectAllVisible}
              onClear={clearSelection}
              onSelectCustom={selectCustomQuickPick}
              onAddCustomField={onAddCustomField}
              onRenameCustomField={onRenameCustomField}
              onDeleteCustomField={onDeleteCustomField}
              documentHref={documentHref}
            />
          </>
        )}
      </div>

      {!schemaDiscovering && !documentProcessing && !schemaDiscoveryError && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy || selectedIds.size === 0}
            onClick={() => {
              setSavedModels(null);
              setSavingSchema((value) => !value);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-text-secondary transition hover:text-foreground disabled:opacity-40"
          >
            <Save className="h-3.5 w-3.5" />
            Save schema
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setSavingSchema(false);
              void openLoadSchema();
            }}
            className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-text-secondary transition hover:text-foreground disabled:opacity-40"
          >
            Reuse saved schema
            {documentFamilyLabel ? ` (${documentFamilyLabel})` : ""}
          </button>
        </div>
      )}

      {savingSchema && (
        <div className="mt-2 flex items-center gap-2 rounded-xl border border-border bg-surface-soft p-2.5">
          <input
            type="text"
            value={saveSchemaName}
            onChange={(event) => setSaveSchemaName(event.target.value)}
            placeholder={`Name this schema (${selectedIds.size} fields)`}
            className="flex-1 bg-transparent px-1.5 text-sm text-foreground outline-none placeholder:text-text-muted"
          />
          <button
            type="button"
            disabled={schemaActionBusy || !saveSchemaName.trim()}
            onClick={() => void saveCurrentSelectionAsSchema()}
            className="btn-secondary px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40"
          >
            {schemaActionBusy ? "Saving…" : "Save"}
          </button>
        </div>
      )}

      {savedModels !== null && (
        <div className="mt-2 rounded-xl border border-border bg-surface-soft p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-foreground">
              Saved schemas
              {documentFamilyLabel ? ` for ${documentFamilyLabel}` : ""}
            </p>
            <button
              type="button"
              onClick={() => setSavedModels(null)}
              className="text-xs text-text-muted hover:text-foreground"
            >
              Close
            </button>
          </div>
          {loadingModels ? (
            <p className="text-xs text-text-muted">Loading…</p>
          ) : savedModels.length === 0 ? (
            <p className="text-xs text-text-muted">
              No saved schemas for this document type.
            </p>
          ) : (
            <ul className="space-y-1">
              {savedModels.map((model) => (
                <li key={model.id}>
                  <button
                    type="button"
                    disabled={schemaActionBusy}
                    onClick={() => void applySchema(model)}
                    className="w-full rounded-lg px-2 py-1.5 text-left text-sm text-foreground hover:bg-surface disabled:opacity-50"
                  >
                    {model.name}
                    <span className="ml-2 text-xs text-text-muted">
                      {model.fields.length} fields
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {schemaActionError && (
        <p className="mt-2 text-xs text-danger">{schemaActionError}</p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <p className="text-sm text-text-secondary" aria-live="polite">
          {selectedIds.size} selected
        </p>
        <button
          type="button"
          disabled={busy || selectedIds.size === 0}
          onClick={() => void runExtraction(Array.from(selectedIds))}
          className="btn-primary inline-flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-40"
          aria-busy={extracting}
          data-testid="extract-selected"
        >
          {extracting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {extractionStageLabel(extractionJob)}
            </>
          ) : (
            <>
              Extract {selectedIds.size} selected
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </>
          )}
        </button>
        {selectedIds.size > 0 && !extracting && (
          <button
            type="button"
            disabled={busy}
            onClick={clearSelection}
            className="btn-secondary text-sm"
          >
            Clear selection
          </button>
        )}
      </div>

      {extractError && (
        <p className="mt-3 text-sm text-danger" role="alert">
          {extractError}
        </p>
      )}
      {noMatch && (
        <p className="mt-3 text-sm text-text-secondary" role="status">
          No values were resolved for the selected targets in this document.
        </p>
      )}

      <div className="mt-6 border-t border-border pt-5">
        <button
          type="button"
          onClick={() => setInstructionExpanded((v) => !v)}
          className="text-xs font-medium text-text-secondary hover:text-foreground"
        >
          {instructionExpanded ? "Hide" : "Show"} custom instruction
        </button>
        {instructionExpanded && (
          <div className="mt-3 space-y-3">
            <ExtractionInstruction
              value={instruction}
              onChange={setInstruction}
              disabled={busy}
              expanded={instructionExpanded}
              onToggleExpand={() => setInstructionExpanded((v) => !v)}
            />
            <button
              type="button"
              disabled={busy || !instruction.trim()}
              onClick={() => void askQuestion()}
              className="btn-secondary text-sm disabled:opacity-40"
            >
              {asking ? "Asking…" : "Ask with custom instruction"}
            </button>
            {askError && <p className="text-xs text-danger">{askError}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
