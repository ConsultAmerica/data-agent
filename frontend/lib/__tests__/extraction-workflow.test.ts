import { describe, expect, it } from "vitest";

import {
  actionableWorkflowError,
  classifyWorkflowError,
  fileTypeLabel,
  resolveClassificationDisplay,
  resolveWorkflowStep,
  workflowStepFromStage,
} from "@/lib/extraction-workflow";

describe("extraction workflow steps", () => {
  it("maps backend stages to product steps without inventing progress", () => {
    expect(workflowStepFromStage("reading_document")).toBe("understand");
    expect(workflowStepFromStage("discovering_fields")).toBe("discover_schema");
    expect(workflowStepFromStage("extracting_data")).toBe("extract");
    expect(workflowStepFromStage("validating_results")).toBe("validate");
    expect(workflowStepFromStage("v3_classification")).toBe("prepare_staging");
    expect(workflowStepFromStage("made_up_stage")).toBeNull();
  });

  it("resolves the active breadcrumb from confirmed UI/backend facts", () => {
    expect(
      resolveWorkflowStep({
        hasDocument: false,
        extracting: false,
        pipelineStage: null,
        schemaReady: false,
        schemaDiscovering: false,
        hasExtractResults: false,
        hasPresentedProfile: false,
        stagingReady: false,
      }),
    ).toBe("upload");

    expect(
      resolveWorkflowStep({
        hasDocument: true,
        extracting: true,
        pipelineStage: "discovering_fields",
        schemaReady: false,
        schemaDiscovering: false,
        hasExtractResults: false,
        hasPresentedProfile: false,
        stagingReady: false,
      }),
    ).toBe("discover_schema");

    expect(
      resolveWorkflowStep({
        hasDocument: true,
        extracting: false,
        pipelineStage: "complete",
        schemaReady: true,
        schemaDiscovering: false,
        hasExtractResults: true,
        hasPresentedProfile: false,
        stagingReady: false,
      }),
    ).toBe("validate");

    expect(
      resolveWorkflowStep({
        hasDocument: true,
        extracting: false,
        pipelineStage: "complete",
        schemaReady: true,
        schemaDiscovering: false,
        hasExtractResults: false,
        hasPresentedProfile: true,
        stagingReady: true,
      }),
    ).toBe("prepare_staging");
  });
});

describe("classification display", () => {
  it("prefers persisted staging resolution over discovery", () => {
    const display = resolveClassificationDisplay({
      persistedFamilyKey: "xml_data",
      persistedProfileLabel: "XML Document",
      discoveryFamilyKey: "invoice",
      discoveryFamilyLabel: "Invoice",
      discoveryConfidence: 0.99,
    });
    expect(display.source).toBe("persisted_profile");
    expect(display.familyLabel).toBe("FAR Clause XML");
    expect(display.profileLabel).toBe("XML Document");
    expect(display.confidence).toBeNull();
    expect(display.unresolved).toBe(false);
  });

  it("never fabricates confidence and says when unresolved", () => {
    const unresolved = resolveClassificationDisplay({});
    expect(unresolved.unresolved).toBe(true);
    expect(unresolved.familyLabel).toBe("Classification unresolved");
    expect(unresolved.confidence).toBeNull();

    const discovery = resolveClassificationDisplay({
      discoveryFamilyKey: "government_contract",
      discoveryFamilyLabel: "Government Contract",
      discoveryConfidence: 0.72,
    });
    expect(discovery.familyLabel).toBe("Government Contract");
    expect(discovery.confidence).toBe(0.72);
  });

  it("does not treat unknown as a resolved family", () => {
    const display = resolveClassificationDisplay({
      discoveryFamilyKey: "unknown",
      discoveryFamilyLabel: "Unknown / General",
      discoveryConfidence: 0.1,
    });
    expect(display.unresolved).toBe(true);
  });
});

describe("file type and errors", () => {
  it("labels file types from MIME/extension without classifying the document", () => {
    expect(fileTypeLabel("application/pdf", "a.pdf")).toBe("PDF");
    expect(fileTypeLabel("application/xml", "clauses.xml")).toBe("XML");
    expect(fileTypeLabel("text/html", "part52.html")).toBe("HTML");
  });

  it("maps actionable errors without exposing stack traces", () => {
    expect(classifyWorkflowError("Unsupported file type")).toBe("unsupported_file");
    expect(classifyWorkflowError("Request timed out")).toBe("processing_timeout");
    expect(classifyWorkflowError("403 Forbidden")).toBe("permission_denied");
    expect(classifyWorkflowError("Failed to fetch")).toBe("backend_unavailable");
    expect(classifyWorkflowError("please re-upload the document")).toBe("missing_source");

    const timeout = actionableWorkflowError("Processing timed out after 120s");
    expect(timeout.title).toBe("Processing timed out");
    expect(timeout.canRetry).toBe(true);
    expect(timeout.body).not.toMatch(/stack|traceback|secret/i);
  });
});
