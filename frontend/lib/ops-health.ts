import { apiUrl } from "@/lib/api";

export type OpsHealthKind =
  | "available"
  | "waking"
  | "unavailable"
  | "degraded"
  | "unknown";

export interface OpsHealthSnapshot {
  kind: OpsHealthKind;
  label: string;
  detail: string;
  readyStatus?: string;
  oracleDryRun?: boolean;
  rbacEnforced?: boolean;
  metadataReviewMutationsEnabled?: boolean;
}

/**
 * Probe live service endpoints. Never infer health from a page rendering.
 */
export async function probeOpsHealth(
  signal?: AbortSignal,
): Promise<OpsHealthSnapshot> {
  try {
    const health = await fetch(apiUrl("/health"), {
      signal,
      cache: "no-store",
    });
    if (!health.ok) {
      return {
        kind: "unavailable",
        label: "Application unavailable",
        detail: `Health check returned HTTP ${health.status}.`,
      };
    }
  } catch {
    return {
      kind: "waking",
      label: "Backend waking or unreachable",
      detail:
        "Could not reach /health. The host may be starting, sleeping, or offline.",
    };
  }

  try {
    const readyResponse = await fetch(apiUrl("/ready"), {
      signal,
      cache: "no-store",
    });
    let body: Record<string, unknown> = {};
    try {
      body = (await readyResponse.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const status = typeof body.status === "string" ? body.status : undefined;
    if (!readyResponse.ok) {
      return {
        kind: "degraded",
        label: "Application available — readiness incomplete",
        detail:
          status === "not_ready"
            ? "Readiness checks failed. Processing or integrations may be unavailable."
            : `Ready check returned HTTP ${readyResponse.status}.`,
        readyStatus: status,
        oracleDryRun: Boolean(body.oracle_dry_run),
        rbacEnforced: Boolean(body.rbac_enforced),
        metadataReviewMutationsEnabled: Boolean(
          body.metadata_review_mutations_enabled,
        ),
      };
    }
    return {
      kind: "available",
      label: "Application available",
      detail: "Liveness and readiness probes succeeded.",
      readyStatus: status ?? "ready",
      oracleDryRun: Boolean(body.oracle_dry_run),
      rbacEnforced: Boolean(body.rbac_enforced),
      metadataReviewMutationsEnabled: Boolean(
        body.metadata_review_mutations_enabled,
      ),
    };
  } catch {
    return {
      kind: "unknown",
      label: "Readiness unknown",
      detail:
        "/health succeeded but /ready could not be completed. Treat integration status as unknown.",
    };
  }
}
