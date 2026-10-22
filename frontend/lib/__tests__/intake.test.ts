import { describe, expect, it } from "vitest";

import { intakeStepForWorkflowStep } from "@/lib/extraction-workflow";
import {
  batchIntakeStep,
  extractableTargets,
  fileStageFromPipeline,
  fileStageStates,
  groupFieldsByUcfPart,
  intakeFormFields,
  newBatchId,
  ucfPartForSection,
} from "@/lib/intake";
import type { DocumentTarget, ScalarTargetResult } from "@/types/document";

function scalar(key: string, section: string | null, page = 1): ScalarTargetResult {
  return {
    target: key,
    normalized_key: key,
    value: "v",
    page,
    confidence: 0.9,
    confidence_band: "high",
    verified: true,
    extraction_method: "deterministic",
    display_method: "deterministic",
    evidence: { page_number: page, source_text: "v", source_reference: "", section },
  };
}

const base = {
  uploaded: true,
  uploading: false,
  processed: false,
  extracted: false,
  pipelineStage: null,
  failed: false,
};

describe("UCF part from a resolved section", () => {
  it("maps UCF section letters to their parts", () => {
    expect(ucfPartForSection("B — Supplies or Services and Prices/Costs")).toBe("part1");
    expect(ucfPartForSection("H — Special Contract Requirements")).toBe("part1");
    expect(ucfPartForSection("I — Contract Clauses")).toBe("part2");
    expect(ucfPartForSection("J — List of Attachments")).toBe("part3");
    expect(ucfPartForSection("K — Representations, Certifications")).toBe("part4");
    expect(ucfPartForSection("M — Evaluation Factors for Award")).toBe("part4");
  });

  it("maps Part headings, attachments and the cover form", () => {
    expect(ucfPartForSection("Part II — Contract Clauses")).toBe("part2");
    expect(ucfPartForSection("Part IV — Representations and Instructions")).toBe("part4");
    expect(ucfPartForSection("Attachment 3 — Wage Determination")).toBe("part3");
    expect(ucfPartForSection("Exhibit A")).toBe("part3");
    expect(ucfPartForSection("SF33 — Solicitation, Offer and Award")).toBe("part1");
  });

  it("never guesses a part for unknown or numbered commercial headings", () => {
    expect(ucfPartForSection(null)).toBe("other");
    expect(ucfPartForSection("")).toBe("other");
    expect(ucfPartForSection("Section 6.2 — Payment Terms")).toBe("other");
    expect(ucfPartForSection("Invoice header")).toBe("other");
  });

  it("groups scalars by part, keeps empty parts, sorts by page", () => {
    const groups = groupFieldsByUcfPart([
      scalar("clause", "I — Contract Clauses", 30),
      scalar("price", "B — Supplies or Services and Prices/Costs", 4),
      scalar("award", "A — Solicitation/Contract Form", 1),
      scalar("misc", null, 2),
    ]);
    expect(groups.map((group) => group.part)).toEqual(["part1", "part2", "part3", "part4", "other"]);
    expect(groups[0].fields.map((field) => field.normalized_key)).toEqual(["award", "price"]);
    expect(groups[1].fields).toHaveLength(1);
    expect(groups[2].fields).toHaveLength(0);
    expect(groups[4].fields.map((field) => field.normalized_key)).toEqual(["misc"]);
  });
});

describe("per-file stage states", () => {
  it("maps only reported backend stages", () => {
    expect(fileStageFromPipeline("rendering_ocr")).toBe("ocr");
    expect(fileStageFromPipeline("discovering_fields")).toBe("layout");
    expect(fileStageFromPipeline("extracting_data")).toBe("extraction");
    expect(fileStageFromPipeline("v3_classification")).toBe("indexing");
    expect(fileStageFromPipeline("complete")).toBeNull();
    expect(fileStageFromPipeline("made_up")).toBeNull();
  });

  it("shows upload progress before a document exists", () => {
    expect(fileStageStates({ ...base, uploaded: false, uploading: true }).upload).toBe("active");
    expect(fileStageStates({ ...base, uploaded: false, failed: true }).upload).toBe("failed");
  });

  it("marks stages before the reported one done and later ones pending", () => {
    const states = fileStageStates({ ...base, pipelineStage: "discovering_fields" });
    expect(states).toEqual({
      upload: "done",
      ocr: "done",
      layout: "active",
      extraction: "pending",
      indexing: "pending",
    });
    expect(fileStageStates({ ...base, pipelineStage: "rendering_ocr", failed: true }).ocr).toBe("failed");
  });

  it("waits for extraction once processed, and is all done once extracted", () => {
    expect(fileStageStates({ ...base, processed: true, staged: false })).toEqual({
      upload: "done",
      ocr: "done",
      layout: "done",
      extraction: "pending",
      indexing: "pending",
    });
    expect(Object.values(fileStageStates({ ...base, processed: true, extracted: true }))).toEqual(
      Array(5).fill("done"),
    );
  });

  it("says unknown instead of guessing for a restored file", () => {
    const states = fileStageStates({ ...base, processed: true, staged: null });
    expect(states.extraction).toBe("unknown");
    expect(states.indexing).toBe("unknown");
    expect(fileStageStates({ ...base, processed: true, staged: true }).indexing).toBe("done");
  });
});

describe("batch header step", () => {
  const file = { uploaded: true, uploading: false, processed: false, extracted: false, failed: false };

  it("follows the slowest live file", () => {
    expect(batchIntakeStep([], null)).toEqual({ step: "upload", complete: false });
    expect(batchIntakeStep([{ ...file, uploaded: false, uploading: true }], null).step).toBe("upload");
    expect(batchIntakeStep([file], null).step).toBe("classification");
    expect(batchIntakeStep([{ ...file, processed: true }], null).step).toBe("extraction");
    expect(batchIntakeStep([{ ...file, extracted: true }, { ...file, failed: true }], null).step).toBe("review");
    expect(batchIntakeStep([{ ...file, extracted: true }], "submitted")).toEqual({ step: "review", complete: true });
  });

  it("maps a single document's workflow step onto the header", () => {
    expect(intakeStepForWorkflowStep("upload")).toBe("upload");
    expect(intakeStepForWorkflowStep("discover_schema")).toBe("classification");
    expect(intakeStepForWorkflowStep("validate")).toBe("extraction");
    expect(intakeStepForWorkflowStep("prepare_staging")).toBe("review");
  });
});

describe("intake fields", () => {
  it("drops blanks and defaults the profile to auto", () => {
    expect(
      intakeFormFields({ batch_id: "b-1", agency: "  ", contracting_officer: " Jane ", extraction_profile: "" }),
    ).toEqual({ batch_id: "b-1", agency: null, contracting_officer: "Jane", extraction_profile: "auto" });
  });

  it("generates batch ids the backend accepts", () => {
    const id = newBatchId(new Date("2026-10-22T10:00:00Z"));
    expect(id).toMatch(/^batch-20261022-[A-Za-z0-9]{1,12}$/);
    expect(id.length).toBeLessThanOrEqual(64);
  });

  it("offers the same extractable targets as the target picker", () => {
    const target = (key: string, extra: Partial<DocumentTarget> = {}): DocumentTarget => ({
      id: key,
      key,
      label: key,
      target_type: "field",
      page_numbers: [1],
      confidence: 0.9,
      source_examples: ["x"],
      parent_section: null,
      columns: [],
      occurrence_count: 1,
      suggested_instruction: null,
      source: "detected",
      ...extra,
    });
    const kept = extractableTargets([
      target("a"),
      target("b", { source: "template" }),
      target("c", { source_examples: [] }),
      target("d", { target_type: "clause" }),
      target("table_p3_1"),
    ]);
    expect(kept.map((item) => item.key)).toEqual(["a"]);
  });
});
