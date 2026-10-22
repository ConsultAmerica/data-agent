import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import OracleIntegrationPanel from "@/components/oracle-integration-panel";
import { ApiError } from "@/lib/api";

const getOraclePayloadPreview = vi.fn();
const sendOraclePayload = vi.fn();
const listIntegrationAudit = vi.fn();

vi.mock("@/lib/reviewed-export", () => ({
  getOraclePayloadPreview: (...args: unknown[]) => getOraclePayloadPreview(...args),
  sendOraclePayload: (...args: unknown[]) => sendOraclePayload(...args),
  listIntegrationAudit: (...args: unknown[]) => listIntegrationAudit(...args),
}));
vi.mock("@/lib/staging-workbook", () => ({
  getStagingProfile: () => Promise.resolve({ oracle_mapping_capability: "planned" }),
}));

const preview = {
  document_id: "d1",
  source_document: "contract.pdf",
  erp_target: "Oracle Fusion Cloud",
  mode: "preview",
  dry_run: true,
  send_allowed: false,
  generated_at: "2026-10-08T12:00:00Z",
  excluded_statuses: ["pending", "rejected"],
  contract_header: {
    contract_number: "C-1",
    counterparty: "Acme Federal LLC",
    effective_date: "2026-10-01",
    contract_value: "125000.00",
  },
  fields: [],
  skipped: [
    {
      field: "Payment Terms",
      field_key: "payment_terms",
      review_status: "pending",
      reason: "pending_or_rejected_not_sent_downstream",
    },
  ],
  authoritative_count: 1,
  skipped_count: 1,
  ready_to_send: false,
  actor: { can_send: true },
};

describe("OracleIntegrationPanel RC2-06", () => {
  beforeEach(() => {
    getOraclePayloadPreview.mockReset();
    sendOraclePayload.mockReset();
    listIntegrationAudit.mockReset();
    listIntegrationAudit.mockResolvedValue([]);
  });

  it("loads preview and lists excluded fields without treating preview as send", async () => {
    getOraclePayloadPreview.mockResolvedValue(preview);
    render(<OracleIntegrationPanel documentId="d1" documentFilename="contract.pdf" />);

    fireEvent.click(screen.getByRole("button", { name: /Generate payload preview/i }));
    await waitFor(() => expect(getOraclePayloadPreview).toHaveBeenCalledWith("d1"));

    expect(screen.getByText(/Oracle Fusion Cloud/)).toBeTruthy();
    expect(screen.getByText(/Payment Terms/)).toBeTruthy();
    expect(screen.getByText(/Blocked from Oracle payload/i)).toBeTruthy();
    // Sending only happens from the confirmation dialog, which stays locked
    // while a check fails.
    expect(screen.queryByRole("button", { name: /Confirm and send/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Review and send/i }));
    const dialog = screen.getByRole("alertdialog", { name: /Confirm Oracle payload transmission/i });
    expect(within(dialog).getByTestId("oracle-check-clean-review")).toHaveAttribute("data-passed", "false");
    expect(within(dialog).getByRole("checkbox")).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: /Confirm and send/i })).toBeDisabled();
    expect(sendOraclePayload).not.toHaveBeenCalled();
  });

  it("blocks the send when required header metadata is missing", async () => {
    getOraclePayloadPreview.mockResolvedValue({
      ...preview,
      contract_header: { contract_number: "C-1" },
      skipped: [],
      skipped_count: 0,
      ready_to_send: true,
    });
    render(<OracleIntegrationPanel documentId="d1" />);
    fireEvent.click(screen.getByRole("button", { name: /Generate payload preview/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Review and send/i }));

    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByTestId("oracle-check-identifier")).toHaveAttribute("data-passed", "true");
    for (const id of ["counterparty", "date", "amount"]) {
      expect(within(dialog).getByTestId(`oracle-check-${id}`)).toHaveAttribute("data-passed", "false");
    }
    expect(within(dialog).getByText(/3 checks must pass/)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /Confirm and send/i })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("requires explicit confirmation before send when ready", async () => {
    getOraclePayloadPreview.mockResolvedValue({
      ...preview,
      skipped: [],
      skipped_count: 0,
      ready_to_send: true,
      authoritative_count: 2,
    });
    sendOraclePayload.mockResolvedValue({
      document_id: "d1",
      integration_audit_id: 42,
      status: "simulated",
      dry_run: true,
      response_snapshot: {
        status: "simulated",
        code: "ORA-200-OK-DRY-RUN",
        message: "dry-run ok",
      },
    });
    listIntegrationAudit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 42,
          integration: "oracle",
          action: "dry_run",
          status: "simulated",
          actor_id: "a1",
          actor_type: "user",
          actor_role: "admin",
          changed_by: "Admin",
          request_id: "corr-1",
          request_snapshot: null,
          response_snapshot: null,
          created_at: "2026-10-08T12:01:00Z",
          detail: "Oracle dry-run send audited",
        },
      ]);

    render(<OracleIntegrationPanel documentId="d1" />);
    fireEvent.click(screen.getByRole("button", { name: /Generate payload preview/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Review and send/i }));

    const dialog = screen.getByRole("alertdialog", { name: /Confirm Oracle payload transmission/i });
    expect(within(dialog).getAllByTestId(/^oracle-check-/).every((item) => item.dataset.passed === "true")).toBe(true);
    const send = within(dialog).getByRole("button", { name: /Confirm and send/i });
    expect(send).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("checkbox"));
    expect(send).not.toBeDisabled();
    fireEvent.click(send);

    await waitFor(() => expect(sendOraclePayload).toHaveBeenCalledWith("d1", true));
    expect(await screen.findAllByText(/Dry-run send audited/i)).toHaveLength(2);
    expect(await screen.findByText(/audit #42/i)).toBeTruthy();
  });

  it("hub layout: mode banner from the preview, schema beside the JSON payload, and an audit table", async () => {
    getOraclePayloadPreview.mockResolvedValue({
      ...preview,
      fields: [
        {
          field: "Contract Number",
          field_key: "contract_number",
          extracted_value: "C-1",
          value: "C-1",
          review_status: "accepted",
          confidence: 0.97,
          validation: { status: "passed" },
          source: { page: 1 },
        },
      ],
    });
    listIntegrationAudit.mockResolvedValue([
      {
        id: 7,
        integration: "oracle",
        action: "send",
        status: "rejected",
        actor_id: "a2",
        actor_type: "user",
        actor_role: "admin",
        changed_by: "Second",
        request_id: "corr-7",
        request_snapshot: null,
        response_snapshot: { code: "ORA-NOT-CONFIGURED" },
        created_at: "2026-10-09T09:00:00Z",
        detail: null,
      },
      {
        id: 3,
        integration: "oracle",
        action: "dry_run",
        status: "simulated",
        actor_id: "a1",
        actor_type: "user",
        actor_role: "admin",
        changed_by: "First",
        request_id: null,
        request_snapshot: null,
        response_snapshot: { code: "ORA-200-OK-DRY-RUN" },
        created_at: "2026-10-08T09:00:00Z",
        detail: null,
      },
    ]);
    render(<OracleIntegrationPanel documentId="d1" layout="hub" />);

    // No mode is claimed before the server reports one.
    expect(screen.getByTestId("oracle-mode-banner")).toHaveAttribute("data-mode", "unknown");
    expect(screen.queryByText(/latency|connected/i)).toBeNull();

    const table = await screen.findByTestId("integration-audit-table");
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "Timestamp",
      "Audit ID / payload ID",
      "Action",
      "Status",
      "Status code",
      "Initiated by",
    ]);
    const rows = within(table).getAllByTestId("integration-audit-row");
    // Chronological: the older dry-run comes first.
    expect(rows[0].textContent).toMatch(/#3.*ORA-200-OK-DRY-RUN.*First/);
    expect(rows[1].textContent).toMatch(/#7.*corr-7.*rejected.*ORA-NOT-CONFIGURED.*Second/);

    fireEvent.click(screen.getByRole("button", { name: /Generate payload preview/i }));
    await screen.findByTestId("oracle-json-preview");
    expect(screen.getByTestId("oracle-mode-banner")).toHaveAttribute("data-mode", "dry-run");
    expect(screen.getByTestId("oracle-mode-banner").textContent).toMatch(/Dry-run \/ simulated/);
    const schema = screen.getByTestId("oracle-payload-schema");
    expect(within(schema).getByText("contract_header.contract_number")).toBeTruthy();
    expect(within(schema).getByText("fields[0]")).toBeTruthy();
    expect(within(schema).getByTestId("oracle-mapping-status").textContent).toMatch(/Target template pending/);
    const json = screen.getByTestId("oracle-json-preview");
    expect(json.textContent).toContain('"erp_target"');
    expect(screen.getByTestId("oracle-payload-size").textContent).toMatch(/\d+\.\d+ KB/);

    fireEvent.click(screen.getByRole("button", { name: /Review and send/i }));
    const summary = within(screen.getByRole("alertdialog")).getByTestId("oracle-confirm-summary");
    expect(summary.textContent).toMatch(/Target environment\s*Dry-run \/ simulated/);
    expect(summary.textContent).toMatch(/Payload size\s*\d+\.\d+ KB/);
  });

  it("surfaces permission errors accessibly", async () => {
    getOraclePayloadPreview.mockRejectedValue(
      new ApiError("Permission denied: oracle.preview", 403),
    );
    render(<OracleIntegrationPanel documentId="d1" />);
    fireEvent.click(screen.getByRole("button", { name: /Generate payload preview/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/do not have permission/i);
  });
});
