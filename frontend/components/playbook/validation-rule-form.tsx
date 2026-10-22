"use client";

import { useEffect, useState, type FormEvent } from "react";

import { ValidationStatusChip } from "@/components/validation/validation-results";
import { listDocuments } from "@/lib/documents";
import {
  RULE_TYPE_LABELS,
  testValidationRule,
  type ValidationResult,
  type ValidationRule,
  type ValidationRuleInput,
  type ValidationRuleType,
  type ValidationSeverity,
} from "@/lib/validation-rules";
import type { DocumentSummary } from "@/types/document";

const FIELD = "w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-foreground";

const TYPE_HELP: Record<ValidationRuleType, string> = {
  regex: "The field's value (first line) must fully match the pattern. Matching ignores case.",
  required_field: "The field must have a value in the extracted data.",
  funding_gap: "Flags a contract whose funded total differs from its priced (or not-to-exceed) total by more than the threshold.",
  max_amount: "The field's dollar amount must not exceed the threshold.",
  field_match: "Two fields must agree, ignoring case, spaces and punctuation — e.g. the UEI on the cover and the UEI in the SAM section.",
};

/** Add a custom validation rule, or edit one (a template's edit is saved as
 * an override that "Reset" undoes). "Test" runs the unsaved rule against a
 * document so the result is visible before saving. */
export default function ValidationRuleForm({
  rule,
  onSubmit,
  onCancel,
}: {
  rule?: ValidationRule;
  onSubmit: (input: ValidationRuleInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(rule?.name ?? "");
  const [ruleType, setRuleType] = useState<ValidationRuleType>(rule?.rule_type ?? "regex");
  const [fieldLabel, setFieldLabel] = useState(rule?.field_label ?? "");
  const [pattern, setPattern] = useState(rule?.pattern ?? "");
  const [threshold, setThreshold] = useState(rule?.threshold != null ? String(rule.threshold) : "");
  const [severity, setSeverity] = useState<ValidationSeverity>(rule?.severity ?? "medium");
  const [description, setDescription] = useState(rule?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [documentId, setDocumentId] = useState("");
  const [testing, setTesting] = useState(false);
  const [preview, setPreview] = useState<{ result?: ValidationResult; error?: string } | null>(null);

  useEffect(() => {
    let active = true;
    listDocuments(200)
      .then((items) => active && setDocuments(items))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const needsField = ruleType !== "funding_gap";
  const needsThreshold = ruleType === "funding_gap" || ruleType === "max_amount";

  function input(): ValidationRuleInput {
    return {
      name: name.trim(),
      rule_type: ruleType,
      field_label: needsField ? fieldLabel.trim() || null : null,
      pattern: ruleType === "regex" || ruleType === "field_match" ? pattern.trim() || null : null,
      threshold: needsThreshold && threshold.trim() !== "" ? Number(threshold) : null,
      severity,
      description: description.trim(),
    };
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSubmit(input());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save the rule.");
    } finally {
      setBusy(false);
    }
  }

  async function runTest() {
    if (!documentId) return;
    setTesting(true);
    setPreview(null);
    try {
      setPreview({ result: await testValidationRule({ ...input(), name: name.trim() || "Preview" }, documentId) });
    } catch (err) {
      setPreview({ error: err instanceof Error ? err.message : "The rule could not be tested." });
    } finally {
      setTesting(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-lg border border-border bg-surface-soft p-4"
      aria-label={rule ? "Edit validation rule" : "Add validation rule"}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <label className="text-xs text-text-secondary lg:col-span-2">
          Name
          <input required value={name} onChange={(event) => setName(event.target.value)} className={`${FIELD} mt-1`} />
        </label>
        <label className="text-xs text-text-secondary lg:col-span-2">
          Rule type
          <select
            value={ruleType}
            onChange={(event) => {
              setRuleType(event.target.value as ValidationRuleType);
              setPreview(null);
            }}
            className={`${FIELD} mt-1`}
          >
            {(Object.keys(RULE_TYPE_LABELS) as ValidationRuleType[]).map((type) => (
              <option key={type} value={type}>
                {RULE_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-text-secondary lg:col-span-2">
          Severity
          <select value={severity} onChange={(event) => setSeverity(event.target.value as ValidationSeverity)} className={`${FIELD} mt-1`}>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </label>
      </div>
      <p className="text-xs text-text-muted">{TYPE_HELP[ruleType]}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {needsField && (
          <label className="text-xs text-text-secondary">
            {ruleType === "field_match" ? "First field" : "Field"}
            <input
              required
              value={fieldLabel}
              onChange={(event) => setFieldLabel(event.target.value)}
              placeholder="Unique Entity ID (UEI)|UEI"
              className={`${FIELD} mt-1`}
            />
            <span className="mt-1 block text-text-muted">The label shown on the document page. Separate alternatives with |.</span>
          </label>
        )}
        {ruleType === "regex" && (
          <label className="text-xs text-text-secondary">
            Pattern
            <input
              required
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
              placeholder="[A-Z0-9]{12}"
              maxLength={300}
              className={`${FIELD} mt-1 font-mono`}
            />
          </label>
        )}
        {ruleType === "field_match" && (
          <label className="text-xs text-text-secondary">
            Second field
            <input
              required
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
              placeholder="SAM UEI"
              className={`${FIELD} mt-1`}
            />
          </label>
        )}
        {needsThreshold && (
          <label className="text-xs text-text-secondary">
            {ruleType === "funding_gap" ? "Allowed gap (USD)" : "Maximum amount (USD)"}
            <input
              required
              type="number"
              min={0}
              step="0.01"
              value={threshold}
              onChange={(event) => setThreshold(event.target.value)}
              placeholder="10000"
              className={`${FIELD} mt-1`}
            />
          </label>
        )}
      </div>
      <label className="block text-xs text-text-secondary">
        Description
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={2} className={`${FIELD} mt-1`} />
      </label>

      <div className="rounded-lg border border-dashed border-border bg-surface p-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[14rem] flex-1 text-xs text-text-secondary">
            Test against document
            <select
              value={documentId}
              onChange={(event) => {
                setDocumentId(event.target.value);
                setPreview(null);
              }}
              className={`${FIELD} mt-1`}
            >
              <option value="">Choose a document…</option>
              {documents.map((document) => (
                <option key={document.document_id} value={document.document_id}>
                  {document.original_filename}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={runTest}
            disabled={!documentId || testing}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-foreground hover:border-primary disabled:opacity-50"
          >
            {testing ? "Testing…" : "Test"}
          </button>
        </div>
        {preview?.result && (
          <p className="mt-2 flex flex-wrap items-center gap-2 text-sm" role="status">
            <ValidationStatusChip status={preview.result.status} />
            <span className="text-text-secondary">{preview.result.detail}</span>
            {preview.result.page && <span className="text-xs text-text-muted">p. {preview.result.page}</span>}
          </p>
        )}
        {preview?.error && <p className="mt-2 text-sm text-danger">{preview.error}</p>}
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="btn-primary disabled:opacity-50">
          {busy ? "Saving…" : rule ? "Save rule" : "Add rule"}
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary hover:text-foreground">
          Cancel
        </button>
      </div>
    </form>
  );
}
