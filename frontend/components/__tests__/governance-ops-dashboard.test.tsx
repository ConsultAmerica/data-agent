import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getPortfolioMock,
  getDashboardStatsMock,
  getDocumentStatusCountsMock,
  searchDocumentsMock,
  getGlobalAuditLogMock,
  startProcessingJobMock,
  getCurrentActorMock,
  probeOpsHealthMock,
} = vi.hoisted(() => ({
  getPortfolioMock: vi.fn(),
  getDashboardStatsMock: vi.fn(),
  getDocumentStatusCountsMock: vi.fn(),
  searchDocumentsMock: vi.fn(),
  getGlobalAuditLogMock: vi.fn(),
  startProcessingJobMock: vi.fn(),
  getCurrentActorMock: vi.fn(),
  probeOpsHealthMock: vi.fn(),
}));

vi.mock("@/lib/portfolio", () => ({
  getPortfolio: (...args: unknown[]) => getPortfolioMock(...args),
}));

vi.mock("@/lib/documents", () => ({
  getDashboardStats: (...args: unknown[]) => getDashboardStatsMock(...args),
  getDocumentStatusCounts: (...args: unknown[]) =>
    getDocumentStatusCountsMock(...args),
  searchDocuments: (...args: unknown[]) => searchDocumentsMock(...args),
  getGlobalAuditLog: (...args: unknown[]) => getGlobalAuditLogMock(...args),
  startProcessingJob: (...args: unknown[]) => startProcessingJobMock(...args),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentActor: (...args: unknown[]) => getCurrentActorMock(...args),
}));

vi.mock("@/lib/ops-health", () => ({
  probeOpsHealth: (...args: unknown[]) => probeOpsHealthMock(...args),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import GovernanceOpsDashboard, {
  mapProcessingLabel,
} from "@/components/governance/governance-ops-dashboard";

const PORTFOLIO = {
  generated_at: "2026-10-08T12:00:00Z",
  totals: {
    documents: 12,
    pages: 40,
    ocr_pages: 2,
    processed: 8,
    processing: 1,
    not_processed: 2,
    failed: 1,
    average_processing_seconds: null,
    staged: 5,
  },
  document_mix: [],
  uploads_by_month: [],
  review: {
    fields: 20,
    pending: 3,
    accepted: 10,
    edited: 4,
    rejected: 1,
    average_confidence: 0.8,
    low_confidence_documents: 2,
  },
  contracts: { count: 0, agencies: [], contractors: [], vehicles: [], naics: [] },
  clauses: { references: 0, top: [] },
  expiring: [],
  risks: {
    total: 0,
    by_severity: { high: 0, medium: 0, low: 0 },
    by_kind: [],
    items: [],
  },
};

describe("mapProcessingLabel", () => {
  it("maps known backend states", () => {
    expect(mapProcessingLabel("queued")).toBe("Queued");
    expect(mapProcessingLabel("processing")).toBe("Processing");
    expect(mapProcessingLabel("failed")).toBe("Failed");
    expect(mapProcessingLabel(null)).toBe("Unknown / unavailable");
  });
});

describe("GovernanceOpsDashboard", () => {
  beforeEach(() => {
    getPortfolioMock.mockReset();
    getDashboardStatsMock.mockReset();
    getDocumentStatusCountsMock.mockReset();
    searchDocumentsMock.mockReset();
    getGlobalAuditLogMock.mockReset();
    startProcessingJobMock.mockReset();
    getCurrentActorMock.mockReset();
    probeOpsHealthMock.mockReset();

    getPortfolioMock.mockResolvedValue(PORTFOLIO);
    getDashboardStatsMock.mockResolvedValue({
      documents_requiring_manual_review: 2,
    });
    getDocumentStatusCountsMock.mockResolvedValue({
      total: 12,
      by_status: {
        processing: 1,
        completed: 8,
        failed: 1,
        review_required: 2,
      },
    });
    searchDocumentsMock.mockResolvedValue({
      documents: [
        {
          document_id: "doc-fail-1",
          original_filename: "broken.pdf",
          document_type: null,
          status: "failed",
          confidence: null,
          uploaded_at: "2026-10-01T00:00:00Z",
          page_count: 1,
          fields_extracted: 0,
          last_updated: "2026-10-02T00:00:00Z",
        },
      ],
      total: 1,
    });
    getGlobalAuditLogMock.mockResolvedValue({
      entries: [
        {
          document_id: "doc-1",
          document_filename: "msa.pdf",
          field_key: "title",
          action: "accept",
          previous_value: null,
          new_value: "MSA",
          changed_by: "Reviewer",
          changed_at: "2026-10-08T11:00:00Z",
        },
      ],
      total: 1,
    });
    probeOpsHealthMock.mockResolvedValue({
      kind: "available",
      label: "Application available",
      detail: "ok",
      readyStatus: "ready",
      oracleDryRun: true,
      rbacEnforced: true,
    });
    getCurrentActorMock.mockResolvedValue({
      id: "a1",
      actor_type: "user",
      display_name: "Ops Admin",
      email: null,
      role: "admin",
      active: true,
      permissions: [
        "extraction.run",
        "review.accept",
        "export.read",
        "oracle.preview",
        "oracle.send",
        "admin.providers",
      ],
    });
  });

  it("renders portfolio metrics with plain-language explanations", async () => {
    render(<GovernanceOpsDashboard />);

    await waitFor(() =>
      expect(screen.getByTestId("ops-metrics")).toBeInTheDocument(),
    );

    expect(screen.getByText("Total documents")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("Every document in this workspace")).toBeTruthy();
    // No API paths or internal switch names on a user-facing page.
    expect(screen.queryByText(/GET \/api|RBAC|API/)).toBeNull();
  });

  it("shows health from probes and recent review activity", async () => {
    render(<GovernanceOpsDashboard />);

    await waitFor(() =>
      expect(screen.getByTestId("ops-health")).toHaveTextContent(
        "Application available",
      ),
    );
    expect(screen.getByTestId("recent-review-activity")).toHaveTextContent(
      "msa.pdf",
    );
  });

  it("hides retry for roles without extraction.run", async () => {
    getCurrentActorMock.mockResolvedValue({
      id: "v1",
      actor_type: "user",
      display_name: "Viewer",
      email: null,
      role: "viewer",
      active: true,
      permissions: ["documents.view"],
    });

    render(<GovernanceOpsDashboard />);

    await waitFor(() =>
      expect(screen.getByTestId("failed-docs-table")).toBeInTheDocument(),
    );
    expect(screen.getByText(/Retry hidden for role/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Retry reprocess/i })).toBeNull();
  });

  it("queues reprocess once and guards duplicate clicks", async () => {
    let resolveJob: (value: unknown) => void = () => undefined;
    startProcessingJobMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveJob = resolve;
        }),
    );

    render(<GovernanceOpsDashboard />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Retry reprocess/i }),
      ).toBeInTheDocument(),
    );

    const button = screen.getByRole("button", { name: /Retry reprocess/i });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(startProcessingJobMock).toHaveBeenCalledTimes(1);
    expect(startProcessingJobMock).toHaveBeenCalledWith("doc-fail-1");

    resolveJob({ id: 99, status: "queued" });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/Reprocess queued/),
    );
  });

  it("does not invent Oracle outcome counts", async () => {
    render(<GovernanceOpsDashboard />);
    await waitFor(() =>
      expect(screen.getAllByText(/Tracked per document/i).length).toBeGreaterThan(0),
    );
    expect(screen.queryByText(/Oracle sends succeeded/i)).toBeNull();
  });
});
