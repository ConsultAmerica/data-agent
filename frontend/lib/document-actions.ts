import { apiFetch, fetchWithRetry } from "@/lib/api";
import { downloadBlob } from "@/lib/export";

/** Mirrors backend app/services/document_actions.py. */
export type ActionOutput = "json" | "csv" | "md";

export interface DocumentAction {
  action_id: string;
  title: string;
  description: string;
  category: string;
  outputs: ActionOutput[];
  available: boolean;
  reason: string | null;
}

export interface ActionFact {
  label: string;
  value: string | null;
  page: number | null;
}

export interface ActionColumn {
  key: string;
  label: string;
}

export type ActionSection =
  | { heading: string; kind: "facts"; facts: ActionFact[] }
  | {
      heading: string;
      kind: "table";
      columns: ActionColumn[];
      rows: Record<string, string | number | null>[];
      empty_message?: string;
    }
  | { heading: string; kind: "text"; text: string };

export interface ActionResult {
  action_id: string;
  title: string;
  document_id: string;
  document_name: string;
  generated_at: string;
  sections: ActionSection[];
  warnings: string[];
}

export function listDocumentActions(documentId: string): Promise<DocumentAction[]> {
  return apiFetch(`/api/documents/${encodeURIComponent(documentId)}/actions`);
}

export function runDocumentAction(documentId: string, actionId: string): Promise<ActionResult> {
  return apiFetch(
    `/api/documents/${encodeURIComponent(documentId)}/actions/${encodeURIComponent(actionId)}`,
  );
}

const MIME: Record<Exclude<ActionOutput, "json">, string> = {
  csv: "text/csv;charset=utf-8;",
  md: "text/markdown;charset=utf-8;",
};

/** Downloads the server-rendered CSV / Markdown, named by the server. */
export async function downloadDocumentAction(
  documentId: string,
  actionId: string,
  format: Exclude<ActionOutput, "json">,
  fallbackName: string,
): Promise<void> {
  const response = await fetchWithRetry(
    `/api/documents/${encodeURIComponent(documentId)}/actions/${encodeURIComponent(actionId)}?format=${format}`,
    undefined,
  );
  if (!response.ok) {
    throw new Error(`Download failed (${response.status})`);
  }
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const filename =
    (encoded ? decodeURIComponent(encoded) : undefined) ??
    /filename="([^"]+)"/.exec(disposition)?.[1] ??
    `${fallbackName.replace(/\.[a-z0-9]+$/i, "")}-${actionId}.${format}`;
  downloadBlob(await response.text(), filename, MIME[format]);
}

export function actionHref(documentId: string, actionId?: string): string {
  const params = new URLSearchParams({ document_id: documentId });
  if (actionId) params.set("action", actionId);
  return `/actions?${params.toString()}`;
}
