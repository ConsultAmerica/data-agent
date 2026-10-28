// Document-level review events (approve/promote) are logged under this
// field key by the backend (api/contract_analysis.py).
export const DOCUMENT_EVENT_FIELD_KEY = "__document__";

export function auditFieldLabel(fieldKey: string): string {
  return fieldKey === DOCUMENT_EVENT_FIELD_KEY ? "Document" : fieldKey;
}
