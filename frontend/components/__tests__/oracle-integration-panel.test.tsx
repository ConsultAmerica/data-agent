import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const preview = {
  document_id: "d1",
  source_document: "contract.pdf",
  erp_target: "Oracle Fusion Cloud",
  mode: "preview",
  dry_run: true,
  send_allowed: false,
  generated_at: "2026-10-08T12:00:00Z",
  excluded_statuses: ["pending", "rejected"],
  contract_header: { contract_number: "C-1" },
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
    expect(screen.getByRole("button", { name: /Confirm and send/i })).toBeDisabled();
    expect(sendOraclePayload).not.toHaveBeenCalled();
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
    await waitFor(() => screen.getByRole("button", { name: /Confirm and send/i }));

    const send = screen.getByRole("button", { name: /Confirm and send/i });
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(send).not.toBeDisabled();
    fireEvent.click(send);

    await waitFor(() => expect(sendOraclePayload).toHaveBeenCalledWith("d1", true));
    expect(await screen.findAllByText(/Dry-run send audited/i)).toHaveLength(2);
    expect(await screen.findByText(/audit #42/i)).toBeTruthy();
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
