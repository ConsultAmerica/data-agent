import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getGlobalAuditLogMock, searchParams } = vi.hoisted(() => ({
  getGlobalAuditLogMock: vi.fn(),
  searchParams: { current: new URLSearchParams() },
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams.current,
}));

vi.mock("@/lib/documents", () => ({
  getGlobalAuditLog: (...args: unknown[]) => getGlobalAuditLogMock(...args),
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

import AuditLogPage from "../page";

describe("AuditLogPage", () => {
  beforeEach(() => {
    getGlobalAuditLogMock.mockReset();
    getGlobalAuditLogMock.mockResolvedValue({
      entries: [
        {
          document_id: "d1",
          document_filename: "contract.pdf",
          field_key: "payment_terms",
          action: "edit",
          previous_value: "Net 30",
          new_value: "Net 45",
          new_status: "edited",
          request_id: "req-abc",
          actor_id: "actor-1",
          actor_role: "reviewer",
          changed_by: "Alex",
          changed_at: "2026-10-08T10:00:00Z",
        },
      ],
      total: 1,
    });
  });

  it("loads and renders audit rows with correlation id", async () => {
    render(<AuditLogPage />);

    await waitFor(() =>
      expect(screen.getByTestId("audit-table")).toBeInTheDocument(),
    );
    expect(screen.getByText("contract.pdf")).toBeTruthy();
    expect(screen.getByText("req-abc")).toBeTruthy();
    expect(
      screen.getByTestId("audit-table").textContent,
    ).toMatch(/Edited/);
  });

  it("applies server-side filters on submit", async () => {
    render(<AuditLogPage />);

    await waitFor(() =>
      expect(getGlobalAuditLogMock).toHaveBeenCalled(),
    );

    fireEvent.change(screen.getByLabelText(/Document ID/i), {
      target: { value: "d1" },
    });
    fireEvent.change(screen.getByLabelText(/Actor \/ changed by/i), {
      target: { value: "Alex" },
    });
    fireEvent.change(screen.getByLabelText(/^Action$/i), {
      target: { value: "edit" },
    });
    fireEvent.change(screen.getByLabelText(/Outcome/i), {
      target: { value: "edited" },
    });
    fireEvent.change(screen.getByLabelText(/Correlation/i), {
      target: { value: "req-abc" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Apply filters/i }));

    await waitFor(() =>
      expect(getGlobalAuditLogMock).toHaveBeenLastCalledWith(
        50,
        0,
        expect.objectContaining({
          documentId: "d1",
          changedBy: "Alex",
          action: "edit",
          outcome: "edited",
          requestId: "req-abc",
        }),
      ),
    );
  });

  it("shows empty state without inventing rows", async () => {
    getGlobalAuditLogMock.mockResolvedValue({ entries: [], total: 0 });
    render(<AuditLogPage />);

    await waitFor(() =>
      expect(screen.getByText(/No audit actions match/i)).toBeTruthy(),
    );
  });

  it("opens filtered to the document a link came from", async () => {
    searchParams.current = new URLSearchParams("document_id=doc-42");
    try {
      getGlobalAuditLogMock.mockResolvedValue({ entries: [], total: 0, limit: 50, offset: 0 });
      render(<AuditLogPage />);
      await waitFor(() => expect(getGlobalAuditLogMock).toHaveBeenCalled());
      expect(getGlobalAuditLogMock.mock.calls[0][2]).toEqual({ documentId: "doc-42" });
    } finally {
      searchParams.current = new URLSearchParams();
    }
  });
});
