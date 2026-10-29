"use client";

import { useCallback, useState } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import { FileImage, FileSpreadsheet, FileText, Sparkles, UploadCloud } from "lucide-react";

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
    <section className="editorial-card p-5 sm:p-6" aria-labelledby="intake-portal-title">
      <h2 id="intake-portal-title" className="text-lg font-medium tracking-tight text-foreground">
        Upload documents
      </h2>
      <p className="mt-0.5 text-sm text-text-secondary">
        Choose a document type, or let Dataomatix detect it from each file&apos;s content.
      </p>

      {/* Document-type chips (as a processor picker): Auto-detect, then every registered profile. */}
      <div className="mt-4 flex flex-wrap gap-2" role="radiogroup" aria-label="Profile">
        {[{ profile_id: "auto", label: "Auto-detect" }, ...profileOptions].map((profile) => {
          const checked = fields.extraction_profile === profile.profile_id;
          const Icon = profile.profile_id === "auto" ? Sparkles : FileText;
          return (
            <button
              key={profile.profile_id}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => onFieldsChange({ ...fields, extraction_profile: profile.profile_id })}
              className={[
                "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-medium tracking-wide transition",
                checked
                  ? "border-primary bg-primary text-white shadow-sm"
                  : "border-border bg-surface text-primary hover:border-primary/50 hover:bg-primary-soft/50",
              ].join(" ")}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {profile.label}
            </button>
          );
        })}
      </div>

      <div
        {...getRootProps()}
        className={[
          "group mt-5 cursor-pointer rounded-2xl border-2 border-dashed px-6 py-14 text-center transition duration-200",
          isDragActive
            ? "scale-[1.01] border-primary bg-primary-soft/60 shadow-lg shadow-primary/10"
            : "border-border bg-gradient-to-b from-surface-soft/70 to-surface hover:border-primary/40 hover:shadow-md",
        ].join(" ")}
        data-testid="batch-dropzone"
      >
        <input {...getInputProps()} aria-label="Choose files to upload" />
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-primary-soft text-primary shadow-sm transition duration-200 group-hover:-translate-y-0.5">
          <UploadCloud className="h-8 w-8" strokeWidth={1.75} />
        </div>
        <p className="mt-5 text-base font-medium text-foreground">
          {isDragActive ? "Drop to add them to this batch" : "Drag and drop files here"}
        </p>
        <p className="mt-1.5 text-sm text-text-secondary">
          or <span className="font-medium text-primary underline-offset-2 group-hover:underline">browse your computer</span>
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2 text-[11px] text-text-muted">
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
        <ul className="mt-3 space-y-1 rounded-xl border border-danger/20 bg-danger/5 p-3 text-xs text-danger" role="alert">
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
