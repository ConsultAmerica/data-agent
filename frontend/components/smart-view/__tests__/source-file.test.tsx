import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import JsonSourceTree, { pathText } from "@/components/smart-view/json-source-tree";
import SourceFileCard from "@/components/smart-view/source-file-card";
import { apiFetch } from "@/lib/api";
import type { UploadedDocument } from "@/types/document";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiFetch: vi.fn(),
}));

function documentWith(name: string, provenance: Record<string, unknown>): UploadedDocument {
  return {
    document_id: "doc-1",
    original_filename: name,
    status: "ready",
    content_type: name.endsWith(".csv") ? "text/csv" : "application/json",
    size_bytes: 10,
    checksum_sha256: null,
    page_count: 1,
    encrypted: false,
    uploaded_at: "2026-10-29T00:00:00Z",
    message: "",
    ingestion_provenance: provenance,
  };
}

describe("SourceFileCard", () => {
  it("shows the detected encoding and delimiter, and flags a guessed encoding", () => {
    render(
      <SourceFileCard document={documentWith("rates.csv", { encoding: "cp1252", encoding_guessed: true, delimiter: "semicolon" })} />,
    );
    expect(screen.getByTestId("source-encoding").textContent).toContain("Windows-1252");
    expect(screen.getByTestId("source-encoding").textContent).toContain("(guessed)");
    expect(screen.getByTestId("source-delimiter").textContent).toBe("Semicolon-separated");
    expect(screen.getByText(/The encoding was guessed/)).toBeTruthy();
  });

  it("doesn't flag an encoding read from valid UTF-8", () => {
    render(<SourceFileCard document={documentWith("lines.csv", { encoding: "utf-8", encoding_guessed: false, delimiter: "tab" })} />);
    expect(screen.getByTestId("source-encoding").textContent).toBe("UTF-8");
    expect(screen.queryByText(/guessed/)).toBeNull();
  });

  it("links an attachment to its email and names an archive's path", () => {
    const { unmount } = render(
      <SourceFileCard
        document={documentWith("award.xlsx", { container_source: "award.eml › award.xlsx", container_parent_document_id: "mail-1" })}
      />,
    );
    const origin = screen.getByTestId("source-origin");
    expect(origin.textContent).toContain("Attached to award.eml › award.xlsx");
    expect(within(origin).getByRole("link", { name: "Open email" }).getAttribute("href")).toBe("/documents/mail-1");
    unmount();

    render(<SourceFileCard document={documentWith("rates.csv", { container_source: "batch.zip › batch/rates.csv" })} />);
    expect(screen.getByTestId("source-origin").textContent).toBe("Unpacked from batch.zip › batch/rates.csv");
  });
});

describe("JsonSourceTree", () => {
  const data = {
    invoice: { number: "INV-7", lines: [{ sku: "A1", amount: 10 }, { sku: "B2", amount: 12.5 }] },
    notes: null,
  };

  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it("writes paths the way the page text does", () => {
    expect(pathText(["invoice", "lines", 2, "amount"])).toBe("invoice.lines[2].amount");
  });

  it("starts collapsed below the top level and expands on click", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ data });
    render(<JsonSourceTree documentId="doc-1" />);
    const invoice = (await screen.findAllByRole("button", { name: /invoice/ })).find((b) => b.hasAttribute("aria-expanded"))!;
    expect(invoice.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("INV-7")).toBeNull();
    fireEvent.click(invoice);
    expect(screen.getByText("INV-7")).toBeTruthy();
    expect(screen.getByText("null")).toBeTruthy();
  });

  it("opens the highlighted value's branch and shows its path", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ data });
    render(<JsonSourceTree documentId="doc-1" highlight="12.5" />);
    await waitFor(() => expect(screen.getByTestId("json-match").textContent).toContain("12.5"));
    expect(screen.getByTestId("json-breadcrumb").textContent).toBe("invoice › lines › [1] › amount");
    expect(apiFetch).toHaveBeenCalledWith("/api/documents/doc-1/source-json");
  });

  it("says when the value isn't in the file, and reports when the tree can't load", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ data });
    const { unmount } = render(<JsonSourceTree documentId="doc-1" highlight="missing" />);
    expect((await screen.findByTestId("json-breadcrumb")).textContent).toContain("is not a value in this file");
    unmount();

    vi.mocked(apiFetch).mockRejectedValue(new Error("The JSON file is too large for the tree view."));
    const onUnavailable = vi.fn();
    render(<JsonSourceTree documentId="doc-2" onUnavailable={onUnavailable} />);
    await waitFor(() => expect(onUnavailable).toHaveBeenCalledWith("The JSON file is too large for the tree view."));
  });
});
