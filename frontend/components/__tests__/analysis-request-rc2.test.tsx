import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import AnalysisRequest from "@/components/analysis-request";
import type { DocumentTarget } from "@/types/document";

function target(id: string, label: string, group = "Document"): DocumentTarget {
  return {
    id,
    key: id,
    label,
    target_type: "field",
    source: "detected",
    confidence: 0.9,
    page_numbers: [1],
    source_examples: [`${label}: sample`],
    discovery_method: "xml_element",
    parent_section: null,
    columns: [],
    occurrence_count: 1,
    suggested_instruction: null,
    group,
  };
}

describe("AnalysisRequest RC2-03 schema panel", () => {
  it("uses profile-specific headings for FAR Clause XML and hides unrelated framing", () => {
    render(
      <AnalysisRequest
        targets={[target("t1", "Provision Yn"), target("t2", "Text")]}
        documentFamily="xml_data"
        documentFamilyLabel="FAR Clause XML"
        onExtractTargets={vi.fn(async () => ({
          document_id: "d",
          scalars: [],
          tables: [],
          unresolved_targets: [],
          warnings: [],
        }))}
        onAnalyze={vi.fn(async () => ({
          document_id: "d",
          instruction: "",
          intent: "extract",
          answer: "",
          values: [],
          tables: [],
          pages_used: [],
          unresolved_requests: [],
          warnings: [],
        }))}
      />,
    );
    expect(screen.getByTestId("schema-extraction-panel").textContent).toMatch(/Clause and provision fields/);
    expect(screen.getByTestId("detected-document").textContent).toMatch(/FAR Clause XML/);
    expect(screen.getByText(/Unrelated invoice or contract presets are not shown/i)).toBeTruthy();
  });

  it("supports field search, select all, clear, and duplicate-submit prevention", async () => {
    const onExtract = vi.fn(
      () =>
        new Promise<never>(() => {
          /* leave in-flight */
        }),
    );
    render(
      <AnalysisRequest
        targets={[target("a", "Alpha"), target("b", "Beta"), target("c", "Gamma")]}
        documentFamily="generic_business"
        documentFamilyLabel="Generic Document"
        onExtractTargets={onExtract as never}
        onAnalyze={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Search schema fields"), {
      target: { value: "Beta" },
    });
    expect(screen.getByRole("checkbox", { name: "Beta" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Alpha" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Search schema fields"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Select all 3/i }));
    expect(screen.getAllByText("3 selected").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId("extract-selected"));
    await waitFor(() => expect(onExtract).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("extract-selected")).toBeDisabled();
    fireEvent.click(screen.getByTestId("extract-selected"));
    expect(onExtract).toHaveBeenCalledTimes(1);
  });

  it("announces schema discovery errors with retry", () => {
    const onRetry = vi.fn();
    render(
      <AnalysisRequest
        targets={[]}
        schemaDiscoveryError="Backend unavailable"
        onRetryDiscovery={onRetry}
        onExtractTargets={vi.fn()}
        onAnalyze={vi.fn()}
      />,
    );
    expect(screen.getByText(/Couldn.t discover this document.s schema/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("states unresolved classification explicitly", () => {
    render(
      <AnalysisRequest
        targets={[]}
        documentFamily="unknown"
        documentFamilyLabel={null}
        onExtractTargets={vi.fn()}
        onAnalyze={vi.fn()}
      />,
    );
    expect(screen.getByTestId("detected-document").textContent).toMatch(/Classification unresolved/);
  });
});
