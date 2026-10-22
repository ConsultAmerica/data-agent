import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import BatchFooter from "@/components/intake/batch-footer";
import BatchIntakePortal from "@/components/intake/batch-intake-portal";
import { BatchQueue, type BatchQueueDeps, type QueueItem } from "@/components/intake/batch-queue";
import ProcessingQueue from "@/components/intake/processing-queue";
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
  it("uploads each file with the batch tags, then processes it", async () => {
    const d = deps();
    const queue = new BatchQueue(() => fields, d);
    queue.addFiles([new File(["a"], "a.pdf"), new File(["b"], "b.pdf")]);
    await settle(queue, (items) => items.every((item) => item.status === "processed"));

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
    // Reused with a discovered schema: no reprocessing.
    expect(d.process).not.toHaveBeenCalled();
    expect(queue.getSnapshot()[0].status).toBe("processed");
  });

  it("reports a failed upload per file and can retry it", async () => {
    const upload = vi.fn().mockRejectedValueOnce(new Error("File too large")).mockResolvedValue(uploaded("doc-1"));
    const queue = new BatchQueue(() => fields, deps({ upload }));
    queue.addFiles([new File(["a"], "a.pdf")]);
    await settle(queue, (items) => items[0].status === "failed");
    expect(queue.getSnapshot()[0].error).toBe("File too large");

    queue.retry(queue.getSnapshot()[0].id);
    await settle(queue, (items) => items[0].status === "processed");
  });

  it("runs full extraction on every processed file with its extractable targets", async () => {
    const d = deps();
    const queue = new BatchQueue(() => fields, d);
    queue.addFiles([new File(["a"], "a.pdf")]);
    await settle(queue, (items) => items[0].status === "processed");

    await act(() => queue.runFullExtraction());
    expect(d.extract).toHaveBeenCalledWith("doc-a.pdf", ["t1"], expect.any(Function));
    const [item] = queue.getSnapshot();
    expect(item.status).toBe("extracted");
    expect(item.fieldsExtracted).toBe(2);
  });
});

describe("BatchIntakePortal", () => {
  beforeEach(() => envMock.mockReturnValue("Local"));

  it("shows the server's real per-file limit and the supported profiles", () => {
    render(
      <BatchIntakePortal config={config} fields={fields} onFieldsChange={vi.fn()} onFiles={vi.fn()} />,
    );
    expect(screen.getByTestId("upload-limit").textContent).toContain("Up to 100 MB per file");
    expect(screen.getByText(/Drop federal contract PDFs, SF 1442s, or modification packages here/)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Auto-detect" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Government Contract" })).toBeInTheDocument();
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
