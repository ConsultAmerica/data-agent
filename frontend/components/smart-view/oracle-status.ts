"use client";

import { useEffect, useState } from "react";

import { getTemplate, listAllProfiles, previewMapping, type MappingProfile, type OracleTemplate } from "@/lib/oracle-templates";

export type MappingState = "ready" | "validation_required" | "unmapped";

export interface CategoryMapping {
  profile: MappingProfile;
  template: OracleTemplate;
  state: MappingState;
  mapped: number;
  columns: number;
  errors: number;
  /** The Smart View category whose records this mapping exports. */
  category: string;
}

export const MAPPING_LABEL: Record<MappingState, string> = {
  ready: "Ready for export",
  validation_required: "Validation required",
  unmapped: "Unmapped",
};

export const MAPPING_TONE: Record<MappingState, string> = {
  ready: "bg-success/10 text-success",
  validation_required: "bg-danger/10 text-danger",
  unmapped: "bg-surface-soft text-text-muted",
};

/** Which category a saved mapping exports, from the table its rows come
 * from — never from the Oracle object's name. */
export function categoryForRowDataset(rowDataset: string | null): string {
  if (!rowDataset) return "header";
  if (/line|clin/.test(rowDataset)) return "lines";
  if (/deliver|performance/.test(rowDataset)) return "deliveries";
  if (/clause/.test(rowDataset)) return "clauses";
  if (/attach/.test(rowDataset)) return "attachments";
  if (/part|contact/.test(rowDataset)) return "parties";
  return "other";
}

/** Saved Oracle mappings for this document's type, each previewed on this
 * document (real validation, nothing assumed). */
export function useOracleMappings(documentId: string, stagingProfileId: string | null) {
  const [mappings, setMappings] = useState<CategoryMapping[] | null>(null);
  useEffect(() => {
    if (!stagingProfileId) return;
    let active = true;
    (async () => {
      try {
        const profiles = await listAllProfiles(stagingProfileId);
        const results = await Promise.all(
          profiles.map(async (profile) => {
            try {
              const [template, preview] = await Promise.all([
                getTemplate(profile.template_id),
                previewMapping(documentId, profile.template_id, profile.spec),
              ]);
              const mapped = profile.spec.mappings.filter((m) => m.source.kind !== "none").length;
              const state: MappingState = mapped === 0 ? "unmapped" : preview.import_ready ? "ready" : "validation_required";
              return { profile, template, state, mapped, columns: template.columns.length, errors: preview.issue_counts.error,
                category: categoryForRowDataset(profile.spec.row_dataset) } as CategoryMapping;
            } catch {
              return null;
            }
          }),
        );
        if (active) setMappings(results.filter((r): r is CategoryMapping => r !== null));
      } catch {
        if (active) setMappings([]);
      }
    })();
    return () => {
      active = false;
    };
  }, [documentId, stagingProfileId]);
  return mappings;
}
