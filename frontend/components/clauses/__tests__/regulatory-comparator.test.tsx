import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IngestedClauseRecord } from "@/lib/playbook";

const api = vi.hoisted(() => ({
  listIngestedClauses: vi.fn(),
  getIngestedClauseTexts: vi.fn(),
}));

vi.mock("@/lib/playbook", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/playbook")>()),
  ...api,
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import RegulatoryComparator from "../regulatory-comparator";

function record(number: string, version: string, text: string, documentId = "far"): IngestedClauseRecord {
  return {
    clause_number: number,
    clause_key: `FAR-${number}`,
    title: "",
    clause_type: "Clause",
    version_date: version,
    prescription: null,
    document_id: documentId,
    filename: `${documentId}.xml`,
    source_text: text,
  };
}

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
});

describe("RegulatoryComparator", () => {
  it("explains what to ingest when no regulation text exists", async () => {
    api.listIngestedClauses.mockResolvedValue([]);
    render(<RegulatoryComparator />);
    expect(await screen.findByText("No FAR or DFARS regulation text ingested yet")).toBeTruthy();
    expect(api.getIngestedClauseTexts).not.toHaveBeenCalled();
  });

  it("diffs two ingested versions of a clause, older → newer", async () => {
    api.listIngestedClauses.mockResolvedValue([
      { clause_number: "52.204-21", title: "Basic Safeguarding", family: "FAR", versions: ["(Nov 2021)", "(Jun 2016)"] },
    ]);
    api.getIngestedClauseTexts.mockResolvedValue({
      clause_number: "52.204-21",
      records: [
        record("52.204-21", "(Nov 2021)", "The Contractor shall apply basic safeguarding controls.", "far-2021"),
        record("52.204-21", "(Jun 2016)", "The Contractor shall apply safeguarding controls.", "far-2016"),
      ],
    });
    render(<RegulatoryComparator initialClause="52.204-21" />);
    const diff = await screen.findByTestId("regulatory-diff");
    expect(diff.querySelector("ins")?.textContent?.trim()).toBe("basic");
    expect(diff.querySelector("del")).toBeNull();
    expect(screen.getByTestId("diff-stats").textContent).toContain("+1 words");
    expect(api.getIngestedClauseTexts).toHaveBeenCalledWith("52.204-21");
  });

  it("says when only one version is ingested, and needs DFARS records for a counterpart", async () => {
    api.listIngestedClauses.mockResolvedValue([
      { clause_number: "52.204-21", title: "Basic Safeguarding", family: "FAR", versions: ["(Nov 2021)"] },
    ]);
    render(<RegulatoryComparator />);
    expect(await screen.findByText(/Every ingested clause has a single version date/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "FAR vs DFARS counterpart" }));
    expect(screen.getByText(/Ingest the DFARS XML to compare/)).toBeTruthy();
  });

  it("compares a FAR clause with a DFARS clause from the same subpart", async () => {
    api.listIngestedClauses.mockResolvedValue([
      { clause_number: "52.204-21", title: "Basic Safeguarding", family: "FAR", versions: ["(Nov 2021)"] },
      { clause_number: "252.203-7002", title: "Whistleblower", family: "DFARS", versions: ["(Dec 2022)"] },
      { clause_number: "252.204-7012", title: "Safeguarding CDI", family: "DFARS", versions: ["(May 2024)"] },
    ]);
    api.getIngestedClauseTexts.mockImplementation(async (number: string) => ({
      clause_number: number,
      records: [
        number === "52.204-21"
          ? record(number, "(Nov 2021)", "safeguard covered contractor information systems")
          : record(number, "(May 2024)", "safeguard covered defense information systems", "dfars"),
      ],
    }));
    render(<RegulatoryComparator />);
    await screen.findByText(/single version date/);
    fireEvent.click(screen.getByRole("button", { name: "FAR vs DFARS counterpart" }));
    expect((screen.getByLabelText("DFARS clause") as HTMLSelectElement).value).toBe("252.204-7012");
    const diff = await screen.findByTestId("regulatory-diff");
    await waitFor(() => expect(diff.querySelector("del")?.textContent?.trim()).toBe("contractor"));
    expect(diff.querySelector("ins")?.textContent?.trim()).toBe("defense");
  });
});
