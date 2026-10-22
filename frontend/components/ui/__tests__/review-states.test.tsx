import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ShieldCheck } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stageChecklist } from "@/components/extraction-live-progress";
import PdfPageViewer from "@/components/pdf-page-viewer";
import EmptyState from "@/components/ui/empty-state";
import ResizableSplit from "@/components/ui/resizable-split";
import { SkeletonPage } from "@/components/ui/skeleton";

vi.mock("@/lib/documents", () => ({
  getGlobalAuditLog: vi.fn(() => Promise.resolve({ entries: [], total: 0 })),
}));

describe("ResizableSplit", () => {
  beforeEach(() => window.localStorage.clear());

  function renderSplit() {
    return render(<ResizableSplit storageKey="test-split" left={<p>Left</p>} right={<p>Right</p>} />);
  }

  it("is a keyboard-operable separator that remembers its position", () => {
    renderSplit();
    const handle = screen.getByRole("separator", { name: "Resize panels" });
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-valuenow", "50");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle).toHaveAttribute("aria-valuenow", "55");
    expect(window.localStorage.getItem("test-split")).toBe("55");

    fireEvent.keyDown(handle, { key: "End" });
    expect(handle).toHaveAttribute("aria-valuenow", "70");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle).toHaveAttribute("aria-valuenow", "70"); // clamped at the max

    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle).toHaveAttribute("aria-valuenow", "30");

    fireEvent.doubleClick(handle);
    expect(handle).toHaveAttribute("aria-valuenow", "50");
  });

  it("starts from the stored split", () => {
    window.localStorage.setItem("test-split", "62");
    renderSplit();
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "62");
  });
});

describe("stageChecklist", () => {
  it("lists only the processing job's real stages, marking done and current", () => {
    const items = stageChecklist("indexing", [
      { stage: "reading_document", at: "t1" },
      { stage: "rendering_ocr", at: "t2" },
      { stage: "indexing", at: "t3" },
    ]);
    expect(items.map((item) => [item.stage, item.status])).toEqual([
      ["reading_document", "done"],
      ["rendering_ocr", "done"],
      ["indexing", "current"],
      ["discovering_fields", "pending"],
    ]);
    expect(items[3].label).toBe("Discovering fields, CLIN schedules and tables");
  });

  it("switches to the extraction job's stages and finishes on complete", () => {
    const items = stageChecklist("complete", [
      { stage: "extracting_data", at: "t1" },
      { stage: "validating_results", at: "t2" },
      { stage: "v3_classification", at: "t3" },
      { stage: "complete", at: "t4" },
    ]);
    expect(items.map((item) => item.stage)).toEqual(["extracting_data", "validating_results", "v3_classification"]);
    expect(items.every((item) => item.status === "done")).toBe(true);
  });
});

describe("PdfPageViewer highlight sync", () => {
  const scrollIntoView = vi.fn();
  beforeEach(() => {
    Element.prototype.scrollIntoView = scrollIntoView;
  });
  afterEach(() => scrollIntoView.mockReset());

  const render_ = {
    page_number: 3,
    image_data_url: "data:image/png;base64,AA==",
    page_width: 600,
    page_height: 800,
    highlight: { x0: 10, y0: 20, x1: 110, y1: 60 },
  };

  it("scrolls the box into view on each pick and reports clicks on it", () => {
    const onHighlightClick = vi.fn();
    const { rerender, container } = render(
      <PdfPageViewer render={render_} loading={false} error="" focusKey={1} onHighlightClick={onHighlightClick} />,
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.calls[0][0]).toMatchObject({ block: "center" });

    // The same value picked again still re-centres it.
    rerender(<PdfPageViewer render={render_} loading={false} error="" focusKey={2} onHighlightClick={onHighlightClick} />);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);

    fireEvent.click(container.querySelector("[data-evidence-highlight]")!);
    expect(onHighlightClick).toHaveBeenCalledTimes(1);
  });

  it("shows a page-shaped skeleton while the first render loads", () => {
    render(<PdfPageViewer render={null} loading error="" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading page…");
  });
});

describe("states", () => {
  it("EmptyState shows title, reassurance and action", () => {
    render(
      <EmptyState icon={ShieldCheck} tone="success" title="No risks found" description="All 3 documents were checked." action={<a href="/x">Go</a>} />,
    );
    expect(screen.getByTestId("empty-state")).toHaveTextContent("No risks found");
    expect(screen.getByText("All 3 documents were checked.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go" })).toBeInTheDocument();
  });

  it("SkeletonPage announces loading without a spinner", () => {
    render(<SkeletonPage label="Loading workspace…" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent("Loading workspace…");
  });

  it("DocumentAuditTrail explains an empty trail", async () => {
    const { default: DocumentAuditTrail } = await import("@/components/review/document-audit-trail");
    render(<DocumentAuditTrail documentId="d1" />);
    await waitFor(() => expect(screen.getByText("No review decisions yet")).toBeInTheDocument());
  });
});
