import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import BatchFooter from "@/components/intake/batch-footer";
import BatchIntakePortal from "@/components/intake/batch-intake-portal";
import { BatchQueue, type BatchQueueDeps, type QueueItem } from "@/components/intake/batch-queue";
import ProcessingQueue, { STALL_AFTER_MS, formatElapsed, processingDetails, progressLine, statusBadge } from "@/components/intake/processing-queue";
import { ApiError } from "@/lib/api";
import UcfFieldReview from "@/components/intake/ucf-field-review";
import type { IntakeConfig, IntakeFields } from "@/lib/intake";
import type { ExtractTargetsResult, UploadedDocument } from "@/types/document";

const { envMock, setStatusMock } = vi.hoisted(() => ({
  envMock: vi.fn(() => "Local" as string | null),
  setStatusMock: vi.fn(),
}));

vi.mock("@/components/navigation/client-env", () => ({
  useDeployEnvironment: envMock,
}));

const { jobMock } = vi.hoisted(() => ({ jobMock: vi.fn() }));
vi.mock("@/lib/documents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/documents")>()),
  getExtractionJob: jobMock,
}));

vi.mock("@/lib/intake", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/intake")>()),
  setIntakeBatchStatus: setStatusMock,
}));

vi.mock("@/components/source-verification-panel", () => ({
  default: ({ request }: { request: { pageNumber: number; label?: string } | null }) => (
    <div data-testid="viewer">{request ? `page ${request.pageNumber}: ${request.label}` : "no selection"}</div>
  ),
}));

const fields: IntakeFields = {
  batch_id: "batch-20261022-abc",
  agency: "GSA",
  contracting_officer: "",
  extraction_profile: "auto",
};

const config: IntakeConfig = {
  max_upload_mb: 100,
  max_pdf_pages: 1000,
  profiles: [{ profile_id: "contract_v3", label: "Government Contract" }],
  profile_override_supported: false,
};

function uploaded(id: string, extra: Partial<UploadedDocument> = {}): UploadedDocument {
  return {
    document_id: id,
    original_filename: `${id}.pdf`,
    status: "ready",
    content_type: "application/pdf",
    size_bytes: 10,
    checksum_sha256: "x",
    page_count: 3,
    encrypted: false,
    uploaded_at: "2026-10-22T00:00:00Z",
    message: "",
    ...extra,
  };
}

function deps(overrides: Partial<BatchQueueDeps> = {}): BatchQueueDeps {
  return {
    ensureReady: vi.fn().mockResolvedValue(undefined),
    upload: vi.fn().mockImplementation(async (file: File) => uploaded(`doc-${file.name}`)),
    resolveDuplicate: vi.fn(),
    selectPortfolioFile: vi.fn(),
    tagDocument: vi.fn().mockResolvedValue(undefined),
    process: vi.fn().mockImplementation(async (_id, _job, onStage) => {
      onStage({ stage: "rendering_ocr", status: "processing" });
      onStage({ stage: "discovering_fields", status: "processing" });
    }),
    progress: vi.fn().mockResolvedValue({ ocr_pages: 2, ocr_completed_pages: 1, page_total: 3 }),
    targets: vi.fn().mockResolvedValue({
      targets: [
        { id: "t1", key: "contract_number", source: "detected", source_examples: ["x"], target_type: "field" },
        { id: "t2", key: "clause", source: "detected", source_examples: ["x"], target_type: "clause" },
      ],
    }),
    extract: vi.fn().mockResolvedValue({ scalars: [{}, {}], tables: [], unresolved_targets: [], warnings: [] }),
    ...overrides,
  } as BatchQueueDeps;
}

async function settle(queue: BatchQueue, predicate: (items: QueueItem[]) => boolean) {
  await waitFor(() => expect(predicate(queue.getSnapshot())).toBe(true));
}

describe("BatchQueue", () => {
  it("uploads each file with the batch tags, then processes and extracts it", async () => {
    const d = deps();
    const queue = new BatchQueue(() => fields, d);
    queue.addFiles([new File(["a"], "a.pdf"), new File(["b"], "b.pdf")]);
    await settle(queue, (items) => items.every((item) => item.status === "extracted"));

    expect(d.upload).toHaveBeenCalledTimes(2);
    expect((d.upload as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual({
      batch_id: "batch-20261022-abc",
      agency: "GSA",
      contracting_officer: null,
      extraction_profile: "auto",
    });
    const [first] = queue.getSnapshot();
    expect(first.documentId).toBe("doc-a.pdf");
    expect(first.ocrRequired).toBe(2);
    expect(first.ocrCompleted).toBe(1);
  });

  it("extracts two files at a time, each file once, and records when each finished", async () => {
    const releases: (() => void)[] = [];
    const d = deps({
      extract: vi.fn().mockImplementation(
        () => new Promise((resolve) => releases.push(() => resolve({ scalars: [{}], tables: [], unresolved_targets: [], warnings: [] }))),
      ),
    });
    const queue = new BatchQueue(() => fields, d);
    queue.addFiles([new File(["a"], "a.pdf"), new File(["b"], "b.pdf"), new File(["c"], "c.pdf")]);
    // Two extract at once; the third waits for a free slot.
    await settle(queue, (items) => items.filter((item) => item.status === "extracting").length === 2);
    expect(d.extract).toHaveBeenCalledTimes(2);
    expect(queue.extractionRunning).toBe(true);
    // Finishing extractions frees slots; the third file then starts.
    await waitFor(() => {
      releases.splice(0).forEach((release) => release());
      expect(queue.getSnapshot().every((item) => item.status === "extracted")).toBe(true);
    });
    expect((d.extract as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]).sort()).toEqual(["doc-a.pdf", "doc-b.pdf", "doc-c.pdf"]);
    for (const item of queue.getSnapshot()) {
      expect(item.startedAt).toEqual(expect.any(Number));
      expect(item.finishedAt).toBeGreaterThanOrEqual(item.startedAt!);
    }
    await waitFor(() => expect(queue.extractionRunning).toBe(false));
  });

  it("details processing with reported pages, batches, last update, retries and errors only", () => {
    const base = { status: "processing", pipelineStage: "rendering_ocr", startedAt: 0, finishedAt: null, pageCount: 288, pagesDone: 120,
      ocrRequired: null, ocrCompleted: null, batchesTotal: null, batchesDone: null, retries: 2, lastProgressAt: 50_000, error: null } as unknown as QueueItem;
    const rows = Object.fromEntries(processingDetails(base, 60_000).map((row) => [row.label, row.value]));
    expect(rows).toEqual({
      Stage: "Reading pages · in progress",
      "Pages read": "120 of 288",
      Elapsed: "1:00",
      "Last update": "0:10 ago",
      Retries: "2",
    });
    // No backend report for over three minutes: flagged, not guessed.
    const stalled = processingDetails({ ...base, lastProgressAt: 0 }, STALL_AFTER_MS + 1_000).find((row) => row.label === "Last update")!;
    expect(stalled.tone).toBe("warning");
    expect(stalled.value).toMatch(/no progress reported/);
    const extracting = processingDetails({ ...base, status: "extracting", pipelineStage: "extracting_data", batchesDone: 3, batchesTotal: 5 }, 60_000);
    expect(extracting.find((row) => row.label === "Batches")?.value).toBe("3 of 5");
    const failed = processingDetails({ ...base, status: "failed", finishedAt: 30_000, error: "Interrupted by a server restart." }, 60_000);
    expect(failed.find((row) => row.label === "Error")).toMatchObject({ value: "Interrupted by a server restart.", tone: "danger" });
    expect(failed.find((row) => row.label === "Last update")).toBeUndefined();
    expect(processingDetails({ ...base, status: "extracted" }, 60_000)).toEqual([]);
  });

  it("tells an unavailable job status apart from a confirmed failure, and retries it", async () => {
    const d = deps({ process: vi.fn().mockRejectedValueOnce(new ApiError("Job not found.", 404)).mockResolvedValue(undefined) });
    const queue = new BatchQueue(() => fields, d);
    queue.addFiles([new File(["a"], "a.pdf")]);
    await settle(queue, (items) => items[0].status === "failed");
    const [item] = queue.getSnapshot();
    expect(item.statusUnavailable).toBe(true);
    expect(item.error).toMatch(/Status unavailable.*isn't a confirmed processing failure/);
    expect(statusBadge(item).label).toBe("Status unavailable");
    expect(processingDetails(item, Date.now()).find((row) => row.label === "Status")?.tone).toBe("warning");
    queue.retry(item.id);
    await settle(queue, (items) => items[0].status === "extracted");
    expect(queue.getSnapshot()[0].statusUnavailable).toBe(false);
  });

  it("shows the backend's finer job states as badges", () => {
    const base = { status: "processing", jobState: null, statusUnavailable: false } as unknown as QueueItem;
    expect(statusBadge(base).label).toBe("Classifying");
    expect(statusBadge({ ...base, jobState: "interrupted" }).label).toBe("Interrupted");
    expect(statusBadge({ ...base, status: "failed", jobState: "partially_complete" }).label).toBe("Partially complete");
    expect(statusBadge({ ...base, status: "failed", jobState: "cancelled" }).label).toBe("Cancelled");
  });

  it("opens diagnostics with the job's state, retries, error and stage timings", async () => {
    jobMock.mockResolvedValueOnce({
      id: 153, document_id: "d", job_type: "processing", status: "failed", state: "partially_complete", stage: "reading_pages",
      progress: 0, error_message: "pages 26–50: MemoryError", retry_count: 2, created_at: "2026-10-29T10:00:00Z",
      started_at: "2026-10-29T10:00:01Z", completed_at: null,
      result: { metrics: { total_ms: 61_000, queue_wait_ms: 12, stages: [{ stage: "document_page_loading", ms: 41_000, percent: 67.2 }] } },
    });
    const item = { id: "i1", name: "Contract - FA30.pdf", status: "failed", jobId: 153, size: 3_100_000, documentId: "d",
      file: null, uploadFraction: 1, pipelineStage: null, pageCount: 288, ocrRequired: null, ocrCompleted: null, error: "x",
      failedPhase: "processing", duplicate: null, portfolio: null, staged: null, profileLabel: null, typeLabel: null, category: null,
      categoryLabel: null, fieldsExtracted: null, note: null } as unknown as QueueItem;
    render(<ProcessingQueue items={[item]} onOpen={vi.fn()} onRetry={vi.fn()} onRemove={vi.fn()} onResolveDuplicate={vi.fn()} onSelectPortfolioFile={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "View diagnostics for Contract - FA30.pdf" }));
    const dialog = await screen.findByRole("dialog", { name: "Diagnostics for Contract - FA30.pdf" });
    expect(await within(dialog).findByTestId("diagnostics-job")).toHaveTextContent("failed (partially_complete)");
    expect(within(dialog).getByTestId("diagnostics-job")).toHaveTextContent("pages 26–50: MemoryError");
    expect(within(dialog).getByTestId("diagnostics-stages")).toHaveTextContent("document page loading41,000 ms67.2%");
    expect(jobMock).toHaveBeenCalledWith(153);

    jobMock.mockRejectedValueOnce(new ApiError("Job not found.", 404));
    fireEvent.click(within(dialog).getByRole("button", { name: "Close diagnostics" }));
    fireEvent.click(screen.getByRole("button", { name: "View diagnostics for Contract - FA30.pdf" }));
    expect(await screen.findByText(/Job 153 is not available from the server/)).toBeInTheDocument();
  });

  it("describes progress with real stages, elapsed time and place in line", () => {
    const base = { startedAt: 1_000, finishedAt: null } as unknown as QueueItem;
    expect(progressLine({ ...base, status: "processing", pipelineStage: "discovering_fields" }, 43_000, -1)).toBe("Finding fields · 0:42");
    expect(progressLine({ ...base, status: "waiting", startedAt: null, pipelineStage: null }, 0, 2)).toBe("Waiting · 2 ahead");
    expect(progressLine({ ...base, status: "processed", pipelineStage: null }, 11_000, -1)).toBe("Waiting to extract · 0:10");
    expect(progressLine({ ...base, status: "extracted", finishedAt: 95_000, pipelineStage: null }, 999_999, -1)).toBe("Done in 1:34");
    expect(progressLine({ ...base, status: "failed", finishedAt: 4_000, pipelineStage: null }, 999_999, -1)).toBe("Failed after 0:03");
    expect(formatElapsed(3_725_000)).toBe("62:05");
    expect(progressLine({ ...base, status: "duplicate", pipelineStage: null }, 9_000, -1)).toBe("Waiting for your choice");
  });

  it("groups a file as soon as it is processed, then takes the staged type after extraction", async () => {
    let staged = false;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const d = deps({
      targets: vi.fn().mockImplementation(async () => ({
        document_family: "government_contract",
        document_family_label: "Government Contract",
        category: "contracts",
        category_label: "Contracts & Awards",
        type_label: staged ? "SF 1442 Contract Award" : "Government Contract",
        targets: [{ id: "t1", key: "contract_number", source: "detected", source_examples: ["x"], target_type: "field" }],
      })),
      extract: vi.fn().mockImplementation(async () => {
        await blocked;
        staged = true;
        return { scalars: [{}], tables: [], unresolved_targets: [], warnings: [] };
      }),
    });
    const queue = new BatchQueue(() => fields, d);
    queue.addFiles([new File(["a"], "a.pdf")]);
    // Categorized while its extraction is still running.
    await settle(queue, (items) => items[0].status === "extracting" && items[0].category === "contracts");
    expect(queue.getSnapshot()[0]).toMatchObject({ categoryLabel: "Contracts & Awards", typeLabel: "Government Contract" });

    release();
    await settle(queue, (items) => items[0].status === "extracted" && items[0].typeLabel === "SF 1442 Contract Award");
  });

  it("holds a duplicate for the user, then tags the resolved document", async () => {
    const d = deps({
      upload: vi.fn().mockResolvedValue(
        uploaded("staged-1", {
          status: "duplicate_pending",
          duplicate: true,
          existing_document: {
            document_id: "existing-1",
            original_filename: "old.pdf",
            size_bytes: 10,
            uploaded_at: "2026-10-01T00:00:00Z",
            file_available: true,
          },
        }),
      ),
      resolveDuplicate: vi.fn().mockResolvedValue(uploaded("existing-1", { reused_existing: true })),
    });
    const queue = new BatchQueue(() => fields, d);
    queue.addFiles([new File(["a"], "a.pdf")]);
    await settle(queue, (items) => items[0].status === "duplicate");

    await act(() => queue.resolveDuplicate(queue.getSnapshot()[0].id, "use_existing"));
    expect(d.resolveDuplicate).toHaveBeenCalledWith("staged-1", "use_existing", "staged-1.pdf", "existing-1");
    expect(d.tagDocument).toHaveBeenCalledWith("existing-1", fields);
    // Reused with a discovered schema: no reprocessing, straight to extraction.
    expect(d.process).not.toHaveBeenCalled();
    await settle(queue, (items) => items[0].status === "extracted");
    expect(d.extract).toHaveBeenCalledWith("existing-1", ["t1"], expect.any(Function), expect.any(Function));
  });

  it("reports a failed upload per file and can retry it", async () => {
    const upload = vi.fn().mockRejectedValueOnce(new Error("File too large")).mockResolvedValue(uploaded("doc-1"));
    const queue = new BatchQueue(() => fields, deps({ upload }));
    queue.addFiles([new File(["a"], "a.pdf")]);
    await settle(queue, (items) => items[0].status === "failed");
    expect(queue.getSnapshot()[0].error).toBe("File too large");

    queue.retry(queue.getSnapshot()[0].id);
    await settle(queue, (items) => items[0].status === "extracted");
  });

  it("extracts each processed file automatically with its extractable targets", async () => {
    const d = deps();
    const queue = new BatchQueue(() => fields, d);
    queue.addFiles([new File(["a"], "a.pdf")]);
    await settle(queue, (items) => items[0].status === "extracted");

    expect(d.extract).toHaveBeenCalledTimes(1);
    expect(d.extract).toHaveBeenCalledWith("doc-a.pdf", ["t1"], expect.any(Function), expect.any(Function));
    const [item] = queue.getSnapshot();
    expect(item.status).toBe("extracted");
    expect(item.fieldsExtracted).toBe(2);
  });
  it("never shows an extracting file back at OCR", async () => {
    const extract = vi.fn(async (_doc: string, _ids: string[], onStage: (job: { stage: string | null; status: string }) => void) => {
      onStage({ stage: null, status: "queued" });
      onStage({ stage: "source_structure", status: "processing" });
      return { scalars: [{}], tables: [], unresolved_targets: [], warnings: [] };
    });
    const queue = new BatchQueue(() => fields, deps({ extract: extract as never }));
    const seen: (string | null)[] = [];
    queue.subscribe(() => {
      const [item] = queue.getSnapshot();
      if (item?.status === "extracting") seen.push(item.pipelineStage);
    });
    queue.addFiles([new File(["a"], "a.pdf")]);
    await settle(queue, (items) => items[0].status === "extracted");
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(["extracting_data"]));
  });
});

describe("BatchIntakePortal", () => {
  beforeEach(() => envMock.mockReturnValue("Local"));

  it("shows the server's real per-file limit and the supported profiles", () => {
    render(
      <BatchIntakePortal config={config} fields={fields} onFieldsChange={vi.fn()} onFiles={vi.fn()} />,
    );
    expect(screen.getByTestId("upload-limit").textContent).toContain("Up to 100 MB per file");
    expect(screen.getByText("Drag and drop files here")).toBeInTheDocument();
    expect(screen.queryByText(/Default agency|Contracting officer/)).not.toBeInTheDocument();
    const types = screen.getByRole("radiogroup", { name: "Profile" });
    expect(within(types).getByRole("radio", { name: "Auto-detect" })).toHaveAttribute("aria-checked", "true");
    expect(within(types).getByRole("radio", { name: "Government Contract" })).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText(/classification/i)).not.toBeInTheDocument();
  });

  it("says a requested profile is only a hint", () => {
    render(
      <BatchIntakePortal
        config={config}
        fields={{ ...fields, extraction_profile: "contract_v3" }}
        onFieldsChange={vi.fn()}
        onFiles={vi.fn()}
      />,
    );
    expect(screen.getByText(/saved with each file as a hint/)).toBeInTheDocument();
  });

  it("queues accepted files and lists the rejected ones", async () => {
    const onFiles = vi.fn();
    render(<BatchIntakePortal config={config} fields={fields} onFieldsChange={vi.fn()} onFiles={onFiles} />);
    const input = screen.getByLabelText("Choose files to upload");
    await act(async () => {
      fireEvent.change(input, {
        target: {
          files: [
            new File(["%PDF"], "award.pdf", { type: "application/pdf" }),
            new File([""], "empty.pdf", { type: "application/pdf" }),
          ],
        },
      });
    });
    await waitFor(() => expect(onFiles).toHaveBeenCalled());
    expect(onFiles.mock.calls[0][0].map((file: File) => file.name)).toEqual(["award.pdf"]);
    expect(screen.getByRole("alert").textContent).toContain("empty.pdf");
  });

  it("refuses ZIP and email files with a reason, and still queues every other file", async () => {
    const onFiles = vi.fn();
    render(<BatchIntakePortal config={config} fields={fields} onFieldsChange={vi.fn()} onFiles={onFiles} />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Choose files to upload"), {
        target: {
          files: [
            new File(["PK"], "batch.zip", { type: "application/zip" }),
            new File(["From: a"], "award.eml", { type: "message/rfc822" }),
            new File(["%PDF"], "award.pdf", { type: "application/pdf" }),
            new File(["a,b"], "rates.csv", { type: "text/csv" }),
          ],
        },
      });
    });
    await waitFor(() => expect(onFiles).toHaveBeenCalled());
    expect(onFiles.mock.calls[0][0].map((file: File) => file.name)).toEqual(["award.pdf", "rates.csv"]);
    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toContain("batch.zip");
    expect(alert).toContain("ZIP archives aren't supported");
    expect(alert).toContain("award.eml");
    expect(alert).toContain("Email files aren't supported");
  });

  it("is honest when the limit cannot be read", () => {
    render(<BatchIntakePortal config={null} configError fields={fields} onFieldsChange={vi.fn()} onFiles={vi.fn()} />);
    expect(screen.getByTestId("upload-limit").textContent).toMatch(/could not be read/);
  });
});

function item(extra: Partial<QueueItem>): QueueItem {
  return {
    id: "q1",
    file: new File(["a"], "a.pdf"),
    name: "a.pdf",
    size: 2048,
    status: "processing",
    uploadFraction: 1,
    documentId: "doc-1",
    pipelineStage: "rendering_ocr",
    pageCount: 3,
    ocrRequired: 2,
    ocrCompleted: 1,
    error: null,
    failedPhase: null,
    duplicate: null,
    portfolio: null,
    staged: null,
    profileLabel: null,
    typeLabel: null,
    category: null,
    categoryLabel: null,
    fieldsExtracted: null,
    note: null,
    ...extra,
  };
}

describe("ProcessingQueue", () => {
  const handlers = {
    onOpen: vi.fn(),
    onRetry: vi.fn(),
    onRemove: vi.fn(),
    onResolveDuplicate: vi.fn(),
    onSelectPortfolioFile: vi.fn(),
  };

  it("labels each file with its detected document type", () => {
    render(<ProcessingQueue items={[item({ typeLabel: "Pay Stub / Paycheck", status: "processed" })]} {...handlers} />);
    expect(screen.getByTestId("queue-type-label").textContent).toBe("Pay Stub / Paycheck");
  });

  it("groups files under their detected category, unrecognized files last", () => {
    render(
      <ProcessingQueue
        items={[
          item({ id: "a", name: "award.pdf", category: "contracts", categoryLabel: "Contracts & Awards" }),
          item({ id: "b", name: "pending.pdf" }),
          item({ id: "c", name: "invoice.pdf", category: "financial", categoryLabel: "Financial" }),
          item({ id: "d", name: "sf1442.pdf", category: "contracts", categoryLabel: "Contracts & Awards" }),
        ]}
        {...handlers}
      />,
    );
    const groups = screen.getAllByTestId("queue-category");
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
      "Contracts & Awards",
      "Financial",
      "Recognizing type…",
    ]);
    expect(within(groups[0]).getAllByTestId("queue-row").map((row) => row.textContent)).toEqual([
      expect.stringContaining("award.pdf"),
      expect.stringContaining("sf1442.pdf"),
    ]);
    expect(within(groups[0]).getByRole("heading").textContent).toBe("Contracts & Awards2");
  });

  it("puts uncategorized files waiting on the user under Needs attention, first", () => {
    render(
      <ProcessingQueue
        items={[
          item({ id: "a", name: "invoice.pdf", category: "financial", categoryLabel: "Financial" }),
          item({ id: "b", name: "portfolio.pdf", status: "portfolio" }),
          item({ id: "c", name: "reading.pdf" }),
        ]}
        {...handlers}
      />,
    );
    const groups = screen.getAllByTestId("queue-category");
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
      "Needs attention",
      "Financial",
      "Recognizing type…",
    ]);
    expect(within(groups[0]).getByTestId("queue-row").textContent).toContain("portfolio.pdf");
  });

  it("keeps a flat list while no file's category is known", () => {
    render(<ProcessingQueue items={[item({ id: "a" }), item({ id: "b", name: "b.pdf" })]} {...handlers} />);
    expect(screen.queryByTestId("queue-category")).not.toBeInTheDocument();
  });

  it("shows no type badge before the type is known", () => {
    render(<ProcessingQueue items={[item({})]} {...handlers} />);
    expect(screen.queryByTestId("queue-type-label")).not.toBeInTheDocument();
  });

  it("shows each file's reported stage and OCR page counts", () => {
    render(<ProcessingQueue items={[item({})]} {...handlers} />);
    const stages = within(screen.getByLabelText("Stages for a.pdf")).getAllByRole("listitem");
    expect(stages.map((stage) => stage.getAttribute("data-state"))).toEqual([
      "done",
      "active",
      "pending",
      "pending",
      "pending",
    ]);
    expect(stages[1].textContent).toContain("1/2 pages");
  });

  it("shows per-file errors with a retry, and opens processed files", () => {
    render(
      <ProcessingQueue
        items={[
          item({ status: "failed", failedPhase: "processing", error: "OCR timed out" }),
          item({ id: "q2", name: "b.pdf", status: "processed", documentId: "doc-2", pipelineStage: null }),
        ]}
        {...handlers}
      />,
    );
    expect(screen.getByText("OCR timed out")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(handlers.onRetry).toHaveBeenCalledWith("q1");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(handlers.onOpen).toHaveBeenCalledWith(expect.objectContaining({ documentId: "doc-2" }));
  });

  it("resolves a duplicate through the duplicate dialog", () => {
    render(
      <ProcessingQueue
        items={[
          item({
            status: "duplicate",
            documentId: null,
            duplicate: {
              stagedId: "staged-1",
              originalFilename: "a.pdf",
              existing: {
                document_id: "existing-1",
                original_filename: "old.pdf",
                size_bytes: 10,
                uploaded_at: "2026-10-01T00:00:00Z",
                file_available: true,
              },
            },
          }),
        ]}
        {...handlers}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    fireEvent.click(screen.getByRole("button", { name: "Use Existing" }));
    expect(handlers.onResolveDuplicate).toHaveBeenCalledWith("q1", "use_existing");
  });
});

describe("BatchFooter", () => {
  beforeEach(() => {
    setStatusMock.mockReset();
    setStatusMock.mockImplementation(async () => ({}));
  });

  it("confirms before rejecting the batch", async () => {
    const onStatusChange = vi.fn();
    render(<BatchFooter batchId="b-1" documentCount={2} busyCount={0} status="draft" onStatusChange={onStatusChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject batch" }));
    expect(setStatusMock).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Reject batch" }));
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith("rejected"));
    expect(setStatusMock).toHaveBeenCalledWith("b-1", "rejected");
  });

  it("approves into the review queue, then links to it", async () => {
    const onStatusChange = vi.fn();
    const { rerender } = render(
      <BatchFooter batchId="b-1" documentCount={1} busyCount={0} status="draft" onStatusChange={onStatusChange} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Approve & push to review queue/ }));
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith("submitted"));
    rerender(<BatchFooter batchId="b-1" documentCount={1} busyCount={0} status="submitted" onStatusChange={onStatusChange} />);
    expect(screen.getByRole("link", { name: /Open review queue/ }).getAttribute("href")).toBe("/review-queue");
  });

  it("is disabled until a document is uploaded and shows API errors", async () => {
    setStatusMock.mockImplementation(async () => {
      throw new Error("Permission denied: documents.upload");
    });
    const { rerender } = render(
      <BatchFooter batchId="b-1" documentCount={0} busyCount={1} status={null} onStatusChange={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /Save as draft/ })).toBeDisabled();
    rerender(<BatchFooter batchId="b-1" documentCount={1} busyCount={0} status={null} onStatusChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Save as draft/ }));
    expect(await screen.findByText("Permission denied: documents.upload")).toBeInTheDocument();
  });
});

describe("UcfFieldReview", () => {
  const result: ExtractTargetsResult = {
    document_id: "doc-1",
    scalars: [
      {
        target: "Contract Number",
        normalized_key: "contract_number",
        value: "N40192-23-D-2803",
        page: 1,
        confidence: 0.95,
        confidence_band: "high",
        verified: true,
        extraction_method: "deterministic",
        display_method: "deterministic",
        evidence: { page_number: 1, source_text: "N40192-23-D-2803", source_reference: "", section: "A — Solicitation/Contract Form" },
      },
      {
        target: "Limitation of Liability",
        normalized_key: "liability",
        value: "52.246-23",
        page: 30,
        confidence: 0.5,
        confidence_band: "low",
        verified: false,
        extraction_method: "ai",
        display_method: "ai",
        evidence: { page_number: 30, source_text: "52.246-23", source_reference: "", section: "I — Contract Clauses" },
      },
    ],
    tables: [],
    unresolved_targets: [],
    warnings: [],
  };

  it("groups fields by UCF part with confidence and jumps the viewer to a field's page", () => {
    const onViewSource = vi.fn();
    render(
      <UcfFieldReview
        documentId="doc-1"
        documentName="award.pdf"
        pageCount={40}
        result={result}
        sourceRequest={null}
        onViewSource={onViewSource}
      />,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual([
      "Part I: 1 field",
      "Part II: 1 field",
      "Part III: 0 fields",
      "Part IV: 0 fields",
      "Other: 0 fields",
    ]);
    expect(screen.getByText("Contract Number")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Confidence 95%" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Part II\b/ }));
    fireEvent.click(screen.getByRole("button", { name: /Limitation of Liability/ }));
    expect(onViewSource).toHaveBeenCalledWith(
      expect.objectContaining({ id: "liability", pageNumber: 30, label: "Limitation of Liability" }),
    );

    fireEvent.click(screen.getByRole("tab", { name: /^Part III:/ }));
    expect(screen.getByText(/No extracted fields were located in this part/)).toBeInTheDocument();
  });
});

describe("BatchIntakePortal document-type chips", () => {
  it("selects a document type by its chip", () => {
    const onFieldsChange = vi.fn();
    render(<BatchIntakePortal config={config} fields={fields} onFieldsChange={onFieldsChange} onFiles={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: "Government Contract" }));
    expect(onFieldsChange).toHaveBeenCalledWith(expect.objectContaining({ extraction_profile: "contract_v3" }));
  });
});
