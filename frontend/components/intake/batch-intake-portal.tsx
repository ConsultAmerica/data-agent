"use client";

import { useCallback, useState } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import { UploadCloud } from "lucide-react";

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

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

/** Multi-file dropzone and the batch's intake tags. Files are checked
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
          : "Unsupported file type",
      }));
      const queued: File[] = [];
      for (const file of accepted) {
        if (!ACCEPTED_EXTENSIONS.includes(extensionOf(file.name))) {
          problems.push({ name: file.name, reason: "Unsupported file type" });
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
  const update = (patch: Partial<IntakeFields>) => onFieldsChange({ ...fields, ...patch });

  return (
    <section className="editorial-card p-5 sm:p-6" aria-labelledby="intake-portal-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="intake-portal-title" className="text-lg font-medium tracking-tight text-foreground">
          Upload portal
        </h2>
        {/* A new batch id is random, so the server-rendered one differs from
            the browser's (which is the one uploads use). */}
        <p className="font-mono text-[11px] text-text-muted" title="Batch id" suppressHydrationWarning>
          {fields.batch_id}
        </p>
      </div>

      <div
        {...getRootProps()}
        className={[
          "mt-4 cursor-pointer rounded-2xl border-2 border-dashed px-6 py-12 text-center transition duration-200",
          isDragActive
            ? "border-primary/50 bg-primary-soft/50"
            : "border-border hover:border-primary/30 hover:bg-surface-soft/60",
        ].join(" ")}
        data-testid="batch-dropzone"
      >
        <input {...getInputProps()} aria-label="Choose files to upload" />
        <div className="file-icon-wrap mx-auto h-14 w-14">
          <UploadCloud className="h-7 w-7" strokeWidth={1.75} />
        </div>
        <p className="mt-5 font-medium text-foreground">
          {isDragActive
            ? "Drop the files to add them to this batch"
            : "Drop federal contract PDFs, SF 1442s, or modification packages here"}
        </p>
        <p className="mt-1.5 text-sm text-text-secondary">or click to choose several files</p>
        <p className="mt-4 text-xs text-text-muted" data-testid="upload-limit">
          {config
            ? `Up to ${config.max_upload_mb} MB per file${config.max_pdf_pages ? ` · PDFs up to ${config.max_pdf_pages.toLocaleString()} pages` : ""} · PDF, Office, text, XML, HTML or images`
            : configError
              ? "The per-file size limit could not be read; the server still enforces it."
              : "Reading the server's upload limit…"}
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

      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <label className="block text-xs font-medium text-text-secondary">
          Default agency
          <input
            type="text"
            value={fields.agency}
            maxLength={200}
            onChange={(event) => update({ agency: event.target.value })}
            placeholder="e.g. Department of the Navy"
            className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary/40"
          />
        </label>
        <label className="block text-xs font-medium text-text-secondary">
          Contracting officer name
          <input
            type="text"
            value={fields.contracting_officer}
            maxLength={200}
            onChange={(event) => update({ contracting_officer: event.target.value })}
            placeholder="e.g. Jane Smith"
            className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary/40"
          />
        </label>
        <label className="block text-xs font-medium text-text-secondary">
          Extraction profile
          <select
            value={fields.extraction_profile}
            onChange={(event) => update({ extraction_profile: event.target.value })}
            className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary/40"
          >
            <option value="auto">Auto-detect</option>
            {profileOptions.map((profile) => (
              <option key={profile.profile_id} value={profile.profile_id}>
                {profile.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="mt-2 text-xs leading-5 text-text-muted">
        Tags apply to files added from now on.
        {hintOnly && fields.extraction_profile !== "auto"
          ? " The requested profile is saved with each file as a hint; Dataomatix still picks the profile from the document's own content."
          : ""}
      </p>
    </section>
  );
}
