import type { OraclePayloadPreview } from "@/lib/reviewed-export";

/**
 * Presentation helpers for the Oracle payload preview: its target
 * environment, its size, a field-by-field schema, and a JSON tokenizer for
 * the highlighted preview. Everything is derived from the preview the
 * server returned — nothing about the connection is assumed.
 */

export interface OracleEnvironment {
  /** "dry-run" when the server simulates the send (oracle_dry_run). */
  kind: "dry-run" | "live";
  label: string;
  description: string;
}

export function oracleEnvironment(preview: Pick<OraclePayloadPreview, "dry_run">): OracleEnvironment {
  if (preview.dry_run) {
    return {
      kind: "dry-run",
      label: "Dry-run / simulated",
      description:
        "A send is validated and written to the audit log, but nothing is delivered to Oracle.",
    };
  }
  return {
    kind: "live",
    label: "Live",
    description:
      "Dry-run is off: a send targets the live Oracle endpoint, and the server refuses it if no endpoint is configured.",
  };
}

/** The preview exactly as the server returned it, pretty-printed. */
export function payloadJson(preview: OraclePayloadPreview): string {
  return JSON.stringify(preview, null, 2);
}

/** UTF-8 size of the payload as compact JSON (what goes over the wire). */
export function payloadBytes(preview: OraclePayloadPreview): number {
  return new TextEncoder().encode(JSON.stringify(preview)).length;
}

export function formatKb(bytes: number): string {
  const kb = bytes / 1024;
  return `${kb < 10 ? kb.toFixed(2) : kb.toFixed(1)} KB`;
}

export interface PayloadSchemaEntry {
  /** The extracted field this value comes from. */
  source: string;
  /** Where it sits in the payload (JSON path). */
  payloadKey: string;
  detail?: string | null;
}

export interface PayloadSchemaGroup {
  id: "contract_header" | "fields";
  label: string;
  description: string;
  entries: PayloadSchemaEntry[];
}

/** Source field → payload key, grouped the way the payload is. */
export function payloadSchema(preview: OraclePayloadPreview): PayloadSchemaGroup[] {
  const labelByKey = new Map(
    (preview.fields ?? []).filter((field) => field.field_key).map((field) => [field.field_key as string, field.field]),
  );
  return [
    {
      id: "contract_header",
      label: "Contract header",
      description: "One key per accepted / edited field, keyed by its export key.",
      entries: Object.keys(preview.contract_header ?? {}).map((key) => ({
        source: labelByKey.get(key) ?? key,
        payloadKey: `contract_header.${key}`,
      })),
    },
    {
      id: "fields",
      label: "Field records",
      description: "Each accepted / edited field with its value, review status, confidence and source page.",
      entries: (preview.fields ?? []).map((field, index) => ({
        source: field.field,
        payloadKey: `fields[${index}]`,
        detail: field.field_key ? `field_key: ${field.field_key}` : null,
      })),
    },
  ];
}

export type JsonTokenKind = "key" | "string" | "number" | "boolean" | "null" | "punctuation" | "space";

export interface JsonToken {
  kind: JsonTokenKind;
  text: string;
}

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false)|(null)|([{}[\],:])|(\s+)/y;

/** Split JSON text into tokens for highlighting. Text it doesn't recognise
 * is kept as punctuation, so the tokens always join back to the input. */
export function tokenizeJson(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let index = 0;
  while (index < text.length) {
    TOKEN.lastIndex = index;
    const match = TOKEN.exec(text);
    if (!match) {
      tokens.push({ kind: "punctuation", text: text[index] });
      index += 1;
      continue;
    }
    const [whole, string, colon, number, boolean, nil, punctuation] = match;
    if (string !== undefined) {
      if (colon !== undefined) {
        tokens.push({ kind: "key", text: string });
        tokens.push({ kind: "punctuation", text: colon });
      } else {
        tokens.push({ kind: "string", text: string });
      }
    } else if (number !== undefined) {
      tokens.push({ kind: "number", text: number });
    } else if (boolean !== undefined) {
      tokens.push({ kind: "boolean", text: boolean });
    } else if (nil !== undefined) {
      tokens.push({ kind: "null", text: nil });
    } else if (punctuation !== undefined) {
      tokens.push({ kind: "punctuation", text: punctuation });
    } else {
      tokens.push({ kind: "space", text: whole });
    }
    index += whole.length;
  }
  return tokens;
}
