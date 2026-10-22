import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  params: new URLSearchParams(),
  replace: vi.fn(),
  listIngestedClauses: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => mocks.params,
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/documents", () => ({ searchDocuments: vi.fn(), getClauses: vi.fn() }));
vi.mock("@/lib/playbook", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/playbook")>()),
  listIngestedClauses: mocks.listIngestedClauses,
}));

import ClauseComparePage from "../compare/page";

beforeEach(() => {
  mocks.listIngestedClauses.mockReset();
  mocks.listIngestedClauses.mockResolvedValue([]);
});

describe("Compare clauses page", () => {
  it("defaults to the regulatory comparator", async () => {
    mocks.params = new URLSearchParams();
    render(<ClauseComparePage />);
    expect(await screen.findByText("No FAR or DFARS regulation text ingested yet")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Regulation texts" }).getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the cross-contract comparison", () => {
    mocks.params = new URLSearchParams("mode=contracts");
    render(<ClauseComparePage />);
    expect(screen.getByRole("button", { name: "Compare Across Contracts" })).toBeTruthy();
    expect(mocks.listIngestedClauses).not.toHaveBeenCalled();
  });
});
