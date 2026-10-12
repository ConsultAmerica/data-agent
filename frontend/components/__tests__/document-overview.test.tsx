import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import DocumentOverview from "@/components/document-overview";
import type { ClassificationDisplay } from "@/lib/extraction-workflow";
import type { UploadedDocument } from "@/types/document";

const document: UploadedDocument = {
  document_id: "d1",
  original_filename: "FAR_Part_52_clauses.xml",
  status: "completed",
  content_type: "application/xml",
  size_bytes: 2048,
  checksum_sha256: null,
  page_count: 1,
  encrypted: false,
  uploaded_at: "2026-10-08T00:00:00Z",
  message: "",
};

const resolved: ClassificationDisplay = {
  familyKey: "xml_data",
  familyLabel: "FAR Clause XML",
  profileLabel: "XML Document",
  source: "persisted_profile",
  confidence: null,
  unresolved: false,
};

function renderOverview(overrides: Partial<ComponentProps<typeof DocumentOverview>> = {}) {
  return render(
    <DocumentOverview
      document={document}
      structureDetection={null}
      classification={resolved}
      extraction={null}
      extracting={false}
      progress={null}
      elapsedSeconds={0}
      waking={false}
      onOpenProcessingDetails={vi.fn()}
      {...overrides}
    />,
  );
}

describe("DocumentOverview", () => {
  it("shows filename, file type, size, family, profile, and status", () => {
    renderOverview();
    expect(screen.getByTestId("document-overview")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "FAR_Part_52_clauses.xml" })).toBeTruthy();
    expect(screen.getByTestId("classification-family").textContent).toBe("FAR Clause XML");
    expect(screen.getByTestId("classification-profile").textContent).toBe("XML Document");
    expect(screen.getByTestId("processing-status").textContent).toBe("Uploaded");
    expect(screen.getByText(/XML ·/)).toBeTruthy();
  });

  it("states classification unresolved explicitly", () => {
    renderOverview({
      classification: {
        familyKey: null,
        familyLabel: "Classification unresolved",
        profileLabel: null,
        source: "unresolved",
        confidence: null,
        unresolved: true,
      },
    });
    expect(screen.getByTestId("classification-family").textContent).toBe("Classification unresolved");
    expect(screen.getByText("Unresolved")).toBeTruthy();
    expect(screen.getByTestId("classification-profile").textContent).toBe("Not resolved yet");
  });

  it("shows source preview when supported and replace control", () => {
    const onReplace = vi.fn();
    renderOverview({
      sourcePreview: "Acquisition 360: Voluntary Survey",
      onReplaceDocument: onReplace,
      documentHref: "/documents/d1",
    });
    expect(screen.getByTestId("source-preview").textContent).toMatch(/Acquisition 360/);
    fireEvent.click(screen.getByRole("button", { name: /Replace/i }));
    expect(onReplace).toHaveBeenCalled();
  });
});
