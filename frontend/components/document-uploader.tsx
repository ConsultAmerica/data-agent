"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import {
  CheckCircle2,
  FileText,
  Loader2,
  UploadCloud,
  X,
} from "lucide-react";

import DuplicateDialog from "@/components/duplicate-dialog";
import PortfolioPicker from "@/components/portfolio-picker";
import {
  ensureBackendHealthy,
  getWarmupStatus,
  markUploadCompleted,
  markUploadStarted,
  startBackendWarmup,
  subscribeWarmupStatus,
  type WarmupStatus,
} from "@/lib/backend-warmup";
import { resolveDuplicate, selectPortfolioFile } from "@/lib/documents";
import { uploadFileWithProgress } from "@/lib/upload";
import { formatBytes } from "@/lib/format";
import type {
  EmbeddedFileSummary,
  ExistingDocumentSummary,
  UploadedDocument,
} from "@/types/document";

export const ACCEPTED_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".doc",
  ".xlsx",
  ".xlsm",
  ".xls",
  ".ods",
  ".pptx",
  ".ppt",
  ".txt",
  ".csv",
  ".tsv",
  ".json",
  ".rtf",
  ".html",
  ".htm",
  ".xml",
  ".png",
  ".jpg",
  ".jpeg",
  ".tif",
  ".tiff",
  ".bmp",
  ".webp",
];

/** MIME → extensions for react-dropzone (shared with the batch dropzone). */
export const ACCEPTED_FILE_TYPES: Record<string, string[]> = {
  "application/pdf": [".pdf"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    [".docx"],
  "application/msword": [".doc"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    [".xlsx"],
  "application/vnd.ms-excel": [".xls"],
  "application/vnd.ms-excel.sheet.macroEnabled.12": [".xlsm"],
  "application/vnd.oasis.opendocument.spreadsheet": [".ods"],
  "text/tab-separated-values": [".tsv"],
  "application/json": [".json"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    [".pptx"],
  "application/vnd.ms-powerpoint": [".ppt"],
  "text/plain": [".txt"],
  "text/csv": [".csv"],
  "application/rtf": [".rtf"],
  "text/rtf": [".rtf"],
  "text/html": [".html", ".htm"],
  "application/xml": [".xml"],
  "text/xml": [".xml"],
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/tiff": [".tif", ".tiff"],
  "image/bmp": [".bmp"],
  "image/webp": [".webp"],
};

/**
 * Explicit upload lifecycle. Processing progress after upload is owned by
 * extraction/new/page.tsx — this component only covers file + service readiness.
 */
type UploadStage =
  | "idle"
  | "file_selected"
  | "service_starting"
  | "uploading"
  | "upload_complete"
  | "failed";

interface DocumentUploaderProps {
  onUploadComplete: (document: UploadedDocument) => void;
}

interface PendingDuplicate {
  documentId: string;
  originalFilename: string;
  existingDocument: ExistingDocumentSummary;
}

interface PendingPortfolio {
  documentId: string;
  files: EmbeddedFileSummary[];
}

export default function DocumentUploader({
  onUploadComplete,
}: DocumentUploaderProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [stage, setStage] = useState<UploadStage>("idle");
  const [uploadFraction, setUploadFraction] = useState(0);
  const [error, setError] = useState("");
  const [pendingDuplicate, setPendingDuplicate] =
    useState<PendingDuplicate | null>(null);
  const [resolving, setResolving] = useState(false);
  const [pendingPortfolio, setPendingPortfolio] =
    useState<PendingPortfolio | null>(null);
  const [selectingPortfolioFile, setSelectingPortfolioFile] =
    useState(false);
  const [warmupStatus, setWarmupStatus] = useState<WarmupStatus>(() =>
    getWarmupStatus(),
  );

  // True once a file is selected and we intend to upload as soon as healthy.
  const uploadWhenReadyRef = useRef(false);
  const uploadingRef = useRef(false);
  const selectedFileRef = useRef<File | null>(null);

  useEffect(() => {
    startBackendWarmup().catch(() => {
      // Background only — selection awaits shared readiness.
    });
    return subscribeWarmupStatus(setWarmupStatus);
  }, []);

  const performUpload = useCallback(
    async (file: File) => {
      if (uploadingRef.current) return;
      uploadingRef.current = true;
      uploadWhenReadyRef.current = false;

      setError("");
      setStage("uploading");
      setUploadFraction(0);
      markUploadStarted();

      try {
        const result = await uploadFileWithProgress<UploadedDocument>(
          "/api/documents/upload",
          file,
          setUploadFraction,
        );

        markUploadCompleted();

        if (result.status === "portfolio_pending" && result.embedded_files) {
          setPendingPortfolio({
            documentId: result.document_id,
            files: result.embedded_files,
          });
          setStage("file_selected");
          return;
        }

        if (result.duplicate && result.existing_document) {
          setPendingDuplicate({
            documentId: result.document_id,
            originalFilename: result.original_filename,
            existingDocument: result.existing_document,
          });
          setStage("file_selected");
          return;
        }

        setStage("upload_complete");
        onUploadComplete(result);
      } catch (uploadError) {
        setStage("failed");
        setError(
          uploadError instanceof Error
            ? uploadError.message
            : "Unable to upload the document.",
        );
      } finally {
        uploadingRef.current = false;
      }
    },
    [onUploadComplete],
  );

  const queueUploadForFile = useCallback(
    (file: File) => {
      selectedFileRef.current = file;
      uploadWhenReadyRef.current = true;
      setError("");

      if (getWarmupStatus() === "healthy") {
        void performUpload(file);
        return;
      }

      // Backend still waking — keep file, show connecting, join shared warm-up.
      setStage("service_starting");
      void ensureBackendHealthy()
        .then(() => {
          const pending = selectedFileRef.current;
          if (!uploadWhenReadyRef.current || !pending || uploadingRef.current) {
            return;
          }
          return performUpload(pending);
        })
        .catch((readyError: unknown) => {
          if (!uploadWhenReadyRef.current) return;
          uploadWhenReadyRef.current = false;
          setStage("failed");
          setError(
            readyError instanceof Error
              ? readyError.message
              : "Processing service is not ready yet.",
          );
        });
    },
    [performUpload],
  );

  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      const file = acceptedFiles[0];
      if (!file) return;

      const extension = file.name
        .toLowerCase()
        .slice(file.name.lastIndexOf("."));

      if (!ACCEPTED_EXTENSIONS.includes(extension)) {
        setError(
          "Please select a supported business document (PDF, Office, text, or image).",
        );
        return;
      }

      setSelectedFile(file);
      setUploadFraction(0);
      // Auto-start: warm → upload now; cold → wait for /health then upload.
      queueUploadForFile(file);
    },
    [queueUploadForFile],
  );

  const {
    getRootProps,
    getInputProps,
    isDragActive,
  } = useDropzone({
    onDrop,
    accept: ACCEPTED_FILE_TYPES,
    multiple: false,
    maxFiles: 1,
  });

  async function handleDuplicateResolution(
    action: "use_existing" | "upload_anyway",
  ) {
    if (!pendingDuplicate) return;

    setResolving(true);
    setError("");

    try {
      const existingId = String(
        pendingDuplicate.existingDocument.document_id,
      );

      try {
        const result = await resolveDuplicate(
          pendingDuplicate.documentId,
          action,
          pendingDuplicate.originalFilename,
          () => setResolving(true),
          existingId,
        );

        setPendingDuplicate(null);
        setStage("upload_complete");
        onUploadComplete(result);
        return;
      } catch (resolveError) {
        const message =
          resolveError instanceof Error
            ? resolveError.message
            : "Unable to resolve the duplicate upload.";

        if (
          action === "upload_anyway" &&
          selectedFile &&
          (message.includes("STAGED_UPLOAD_EXPIRED") ||
            message.includes("No pending upload found"))
        ) {
          const result = await uploadFileWithProgress<UploadedDocument>(
            "/api/documents/upload?allow_duplicate=true",
            selectedFile,
            setUploadFraction,
          );
          setPendingDuplicate(null);
          setStage("upload_complete");
          onUploadComplete(result);
          return;
        }

        throw resolveError instanceof Error
          ? resolveError
          : new Error(message);
      }
    } catch (resolveError) {
      setError(
        resolveError instanceof Error
          ? resolveError.message
          : "Unable to resolve the duplicate upload.",
      );
    } finally {
      setResolving(false);
    }
  }

  function handleCancelDuplicate() {
    setPendingDuplicate(null);
    setStage("file_selected");
  }

  async function handlePortfolioSelection(filename: string) {
    if (!pendingPortfolio) return;

    setSelectingPortfolioFile(true);
    setError("");

    try {
      const result = await selectPortfolioFile(
        pendingPortfolio.documentId,
        filename,
        () => setSelectingPortfolioFile(true),
      );

      setPendingPortfolio(null);

      if (result.duplicate && result.existing_document) {
        setPendingDuplicate({
          documentId: result.document_id,
          originalFilename: result.original_filename,
          existingDocument: result.existing_document,
        });
        setStage("file_selected");
        return;
      }

      setStage("upload_complete");
      onUploadComplete(result);
    } catch (selectError) {
      setError(
        selectError instanceof Error
          ? selectError.message
          : "Unable to extract the selected document.",
      );
    } finally {
      setSelectingPortfolioFile(false);
    }
  }

  function handleCancelPortfolio() {
    setPendingPortfolio(null);
    setStage("file_selected");
  }

  function clearFile() {
    uploadWhenReadyRef.current = false;
    selectedFileRef.current = null;
    setSelectedFile(null);
    setStage("idle");
    setUploadFraction(0);
    setError("");
  }

  function retryUpload() {
    if (!selectedFile || uploadingRef.current) return;
    queueUploadForFile(selectedFile);
  }

  const busy = stage === "service_starting" || stage === "uploading";
  const percent = Math.round(uploadFraction * 100);
  const serviceReady = warmupStatus === "healthy";

  return (
    <div className="editorial-card p-8">
      <div className="mb-6">
        <h2 className="text-xl font-medium tracking-tight text-foreground">
          Upload document
        </h2>

        <p className="mt-2 text-sm leading-6 text-text-secondary">
          Contracts, invoices, regulatory documents, spreadsheets, scans, images, and business records. Dataomatix detects the document type and staging profile.
        </p>
      </div>

      {!selectedFile ? (
        <div
          {...getRootProps()}
          className={[
            "cursor-pointer rounded-2xl border-2 border-dashed p-10 text-center transition duration-200",
            isDragActive
              ? "border-primary/40 bg-primary-soft/50"
              : "border-border hover:border-primary/25 hover:bg-surface-soft/60",
          ].join(" ")}
        >
          <input {...getInputProps()} />

          <div className="file-icon-wrap mx-auto h-14 w-14">
            <UploadCloud className="h-7 w-7" strokeWidth={1.75} />
          </div>

          <p className="mt-5 font-medium text-foreground">
            {isDragActive
              ? "Drop your document here"
              : "Drag and drop a document"}
          </p>

          <p className="mt-1.5 text-sm text-text-secondary">
            or click to browse your computer
          </p>

          <span className="btn-secondary mt-6 inline-flex pointer-events-none">
            Browse Files
          </span>

          <p className="mt-5 text-xs text-text-muted">
            <span className="font-medium text-text-secondary">PDF</span>{" "}
            (full source) · Office / text (native extract) · Images (OCR)
          </p>

          {warmupStatus === "warming" && (
            <p className="mt-4 text-xs text-text-muted">
              Connecting to processing service in the background…
            </p>
          )}
          {serviceReady && (
            <p className="mt-4 text-xs font-medium text-success">
              Processing service ready
            </p>
          )}
        </div>
      ) : (
        <div className="rounded-2xl border border-border bg-surface-soft/50 p-5">
          <div className="flex items-center gap-4">
            <div className="file-icon-wrap h-12 w-12 shrink-0">
              <FileText className="h-6 w-6" strokeWidth={1.75} />
            </div>

            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-foreground">
                {selectedFile.name}
              </p>

              <p className="mt-1 text-sm text-text-secondary">
                {formatBytes(selectedFile.size)}
              </p>
            </div>

            {!busy && stage !== "upload_complete" && (
              <button
                type="button"
                onClick={clearFile}
                className="rounded-lg p-2 text-text-muted transition duration-200 hover:bg-surface hover:text-foreground"
                aria-label="Remove selected file"
              >
                <X className="h-5 w-5" strokeWidth={1.75} />
              </button>
            )}
          </div>

          <ul className="mt-5 space-y-2 text-sm">
            <li className="flex items-center gap-2 text-success">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              File ready
            </li>

            {stage === "service_starting" && (
              <li className="flex items-start gap-2 text-text-secondary">
                <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
                <span>
                  <span className="font-medium text-foreground">
                    Connecting to processing service…
                  </span>
                  <span className="mt-1 block text-xs text-text-muted">
                    Processing service is starting. Your file is ready and will
                    upload automatically.
                  </span>
                </span>
              </li>
            )}

            {serviceReady && stage !== "service_starting" && (
              <li className="flex items-center gap-2 text-success">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                Processing service ready
              </li>
            )}

            {stage === "uploading" && (
              <li className="flex items-center gap-2 text-foreground">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                Uploading document… {percent}%
              </li>
            )}

            {stage === "upload_complete" && (
              <li className="flex items-center gap-2 text-success">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                Uploaded
              </li>
            )}
          </ul>

          {stage === "uploading" && (
            <div className="progress-violet mt-3">
              <div
                className="progress-violet-fill"
                style={{ width: `${percent}%` }}
              />
            </div>
          )}

          {stage === "failed" && (
            <div className="mt-5 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={retryUpload}
                disabled={busy}
                className="btn-primary disabled:cursor-not-allowed disabled:opacity-60"
              >
                <UploadCloud className="h-4 w-4" />
                Retry upload
              </button>
            </div>
          )}

          {stage === "service_starting" && (
            <p className="mt-4 text-xs text-text-muted">
              This wait is for the API host to wake — the document has not been
              uploaded or processed yet.
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-xl border border-danger/20 bg-danger/5 p-3 text-sm text-danger">
          {error}
        </div>
      )}

      {pendingDuplicate && (
        <DuplicateDialog
          existingDocument={pendingDuplicate.existingDocument}
          busy={resolving}
          onUseExisting={() =>
            handleDuplicateResolution("use_existing")
          }
          onUploadAnyway={() =>
            handleDuplicateResolution("upload_anyway")
          }
          onCancel={handleCancelDuplicate}
        />
      )}

      {pendingPortfolio && (
        <PortfolioPicker
          files={pendingPortfolio.files}
          busy={selectingPortfolioFile}
          onSelect={handlePortfolioSelection}
          onCancel={handleCancelPortfolio}
        />
      )}
    </div>
  );
}
