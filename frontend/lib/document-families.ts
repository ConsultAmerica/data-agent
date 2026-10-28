/**
 * Mirrors backend/app/services/structure_detection.py DOCUMENT_FAMILIES
 * keys. Used to tag extraction models by document type and to render
 * human-readable category labels/chips in the UI.
 */
export const DOCUMENT_FAMILY_LABELS: Record<string, string> = {
  "*": "General",
  contract: "Contract",
  supplier_agreement: "Supplier Agreement",
  master_services_agreement: "Master Services Agreement",
  sow: "Statement of Work",
  amendment: "Amendment",
  government_contract: "Government Contract",
  procurement: "Procurement",
  financial_report: "Financial Report",
  financial_statement: "Financial Statement",
  budget: "Budget",
  statement: "Bank / Account Statement",
  invoice: "Invoice",
  purchase_order: "Purchase Order",
  laboratory_report: "Laboratory Report",
  passport: "Passport",
  driving_licence: "Driving Licence",
  identity_card: "Identity Card",
  academic_transcript: "Academic Transcript",
  pay_stub: "Pay Stub / Paycheck",
  bank_check: "Bank Cheque",
  receipt: "Receipt",
  tax_form: "Tax Form",
  utility_bill: "Utility Bill",
  insurance_policy: "Insurance Policy",
  quotation: "Quotation",
  credit_note: "Credit Note",
  shipping_document: "Shipping Document",
  resume: "Resume / CV",
  business_requirements: "Business Requirements",
  research_idea: "Research / Idea",
  rate_card: "Rate Card",
  technical_specification: "Technical Specification",
  generic_business: "General Business Document",
  unknown: "Unknown / General",
};

export function documentFamilyLabel(key: string): string {
  return DOCUMENT_FAMILY_LABELS[key] ?? key;
}

/** Staging family labels — persisted resolution vocabulary, not filenames. */
export const FAMILY_LABELS: Record<string, string> = {
  invoice: "Invoice",
  academic_transcript: "Academic Transcript",
  government_contract: "Government Contract",
  far_regulation: "FAR Regulation",
  far_regulatory_change: "FAR Final Rule",
  xml_data: "FAR Clause XML",
  correspondence: "Correspondence",
  passport: "Passport",
  driving_licence: "Driving Licence",
  identity_card: "Identity Card",
  pay_stub: "Pay Stub / Paycheck",
  bank_check: "Bank Cheque",
  receipt: "Receipt",
  tax_form: "Tax Form",
  utility_bill: "Utility Bill",
  insurance_policy: "Insurance Policy",
  quotation: "Quotation",
  credit_note: "Credit Note",
  shipping_document: "Shipping Document",
  resume: "Resume / CV",
  generic_business: "Generic Document",
  unknown: "Generic Document",
};
