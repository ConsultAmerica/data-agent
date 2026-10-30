"use client";

import { useCallback, useState } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import { Check, FileImage, FileSpreadsheet, FileText, Sparkles, UploadCloud } from "lucide-react";

import { ACCEPTED_EXTENSIONS, ACCEPTED_FILE_TYPES } from "@/components/document-uploader";
import type { IntakeConfig, IntakeFields } from "@/lib/intake";

interface BatchIntakePortalProps {
  config: IntakeConfig | null;
  /** Set when /api/intake/config could not be read. */
  configError?: boolean;
  fields: IntakeFields;
  onFieldsChange: (fields: IntakeFields) => void;
  onFiles: (files: File[]) => void;
}

/** Files that hold other files. Not accepted: the documents inside are
 * uploaded individually instead. */
const CONTAINER_REASONS: Record<string, string> = {
  ".zip": "ZIP archives aren't supported. Upload the documents they contain individually",
  ".eml": "Email files aren't supported. Upload the attachments individually",
  ".msg": "Email files aren't supported. Upload the attachments individually",
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

/** Multi-file dropzone and the batch's extraction profile. Files are checked
 * against the server's real per-file limit before they are queued. */
export default function BatchIntakePortal({
  config,
  configError = false,
  fields,
  onFieldsChange,
  onFiles,
}: BatchIntakePortalProps) {
  const [rejected, setRejected] = useState<{ name: string; reason: string }[]>([]);
  const maxBytes = config ? config.max_upload_mb * 1024 * 1024 : null;

  const onDrop = useCallback(
    (accepted: File[], rejections: FileRejection[]) => {
      const problems: { name: string; reason: string }[] = rejections.map((rejection) => ({
        name: rejection.file.name,
        reason: rejection.errors.some((error) => error.code === "file-too-large")
          ? `Larger than the ${config?.max_upload_mb ?? "?"} MB per-file limit`
          : (CONTAINER_REASONS[extensionOf(rejection.file.name)] ?? "Unsupported file type"),
      }));
      const queued: File[] = [];
      for (const file of accepted) {
        if (!ACCEPTED_EXTENSIONS.includes(extensionOf(file.name))) {
          problems.push({ name: file.name, reason: CONTAINER_REASONS[extensionOf(file.name)] ?? "Unsupported file type" });
        } else if (file.size === 0) {
          problems.push({ name: file.name, reason: "The file is empty" });
        } else {
          queued.push(file);
        }
      }
      setRejected(problems);
      onFiles(queued);
    },
    [config?.max_upload_mb, onFiles],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: ACCEPTED_FILE_TYPES,
    multiple: true,
    ...(maxBytes ? { maxSize: maxBytes } : {}),
  });

  const profileOptions = config?.profiles ?? [];
  const hintOnly = config ? !config.profile_override_supported : true;

  return (
    <section className="data-panel p-4 sm:p-5" aria-labelledby="intake-portal-title">
      <h2 id="intake-portal-title" className="text-[15px] font-semibold tracking-tight text-foreground">
        Upload documents
      </h2>
      <p className="mt-0.5 text-[13px] text-text-secondary">
        Choose a document type, or let Dataomatix detect it from each file&apos;s content.
      </p>

      {/* Document-type picker (as a processor picker): Auto-detect, then every registered profile. */}
      <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted" aria-hidden="true">
        Document type
      </p>
      <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3" role="radiogroup" aria-label="Profile">
        {[{ profile_id: "auto", label: "Auto-detect" }, ...profileOptions].map((profile) => {
          const checked = fields.extraction_profile === profile.profile_id;
          const auto = profile.profile_id === "auto";
          const Icon = auto ? Sparkles : FileText;
          return (
            <button
              key={profile.profile_id}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={profile.label}
              title={profile.label}
              onClick={() => onFieldsChange({ ...fields, extraction_profile: profile.profile_id })}
              className={[
                "flex min-w-0 items-center gap-2 rounded-lg border text-left text-[13px] font-medium transition-colors",
                auto ? "col-span-full px-3 py-2.5" : "h-9 px-2.5",
                checked
                  ? "border-primary bg-primary-soft text-primary ring-1 ring-inset ring-primary"
                  : "border-border bg-surface text-foreground hover:border-primary/40 hover:bg-surface-soft",
              ].join(" ")}
            >
              <span
                className={[
                  "flex shrink-0 items-center justify-center rounded-md",
                  auto ? "h-8 w-8" : "h-5 w-5",
                  checked ? "bg-primary text-white" : auto ? "bg-primary-soft text-primary" : "text-text-muted",
                ].join(" ")}
              >
                <Icon className={auto ? "h-4 w-4" : "h-3.5 w-3.5"} aria-hidden="true" />
              </span>
              {auto ? (
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    {profile.label}
                    <span className="rounded bg-success/10 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-success">
                      Recommended
                    </span>
                  </span>
                  <span className="block truncate text-xs font-normal text-text-secondary">
                    Each file&apos;s type is detected from its own content, so mixed batches work.
                  </span>
                </span>
              ) : (
                <span className="min-w-0 flex-1 truncate">{profile.label}</span>
              )}
              {checked && <Check className="h-4 w-4 shrink-0 text-primary" strokeWidth={2.5} aria-hidden="true" />}
            </button>
          );
        })}
      </div>

      <div
        {...getRootProps()}
        className={[
          "group mt-4 cursor-pointer rounded-xl border-2 border-dashed px-6 py-10 text-center transition duration-200",
          isDragActive
            ? "border-primary bg-primary-soft/60"
            : "border-border bg-surface-soft/50 hover:border-primary/40 hover:bg-primary-soft/30",
        ].join(" ")}
        data-testid="batch-dropzone"
      >
        <input {...getInputProps()} aria-label="Choose files to upload" />
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-surface text-primary shadow-sm ring-1 ring-border transition duration-200 group-hover:-translate-y-0.5">
          <UploadCloud className="h-6 w-6" strokeWidth={1.75} />
        </div>
        <p className="mt-4 text-sm font-semibold text-foreground">
          {isDragActive ? "Drop to add them to this batch" : "Drag and drop files here"}
        </p>
        <p className="mt-1 text-[13px] text-text-secondary">
          or <span className="font-medium text-primary underline-offset-2 group-hover:underline">browse your computer</span>
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-1.5 text-[11px] text-text-muted">
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1">
            <FileText className="h-3 w-3" aria-hidden="true" /> PDF &amp; Word
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1">
            <FileImage className="h-3 w-3" aria-hidden="true" /> Images &amp; scans
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1">
            <FileSpreadsheet className="h-3 w-3" aria-hidden="true" /> Excel, XML &amp; text
          </span>
        </div>
        <p className="mt-3 min-h-4 text-xs text-text-muted" data-testid="upload-limit">
          {config
            ? `Up to ${config.max_upload_mb} MB per file${config.max_pdf_pages ? ` · ${config.max_pdf_pages.toLocaleString()} pages per PDF` : ""}`
            : configError
              ? "The per-file size limit could not be read; the server still enforces it."
              : ""}
        </p>
      </div>

      {rejected.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2.5 text-xs text-danger" role="alert">
          {rejected.map((problem, index) => (
            <li key={`${problem.name}-${index}`}>
              <span className="font-medium">{problem.name}</span>: {problem.reason}
            </li>
          ))}
        </ul>
      )}

      {hintOnly && fields.extraction_profile !== "auto" && (
        <p className="mt-3 text-xs leading-5 text-text-muted">
          The requested profile is saved with each file as a hint; Dataomatix still picks the profile from the
          document&apos;s own content.
        </p>
      )}
    </section>
  );
}
