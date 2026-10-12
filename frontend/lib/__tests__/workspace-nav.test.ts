import { describe, expect, it } from "vitest";

import {
  WORKSPACE_NAV,
  breadcrumbsForPath,
  isMarketingPath,
  isNavItemActive,
  isWorkspacePath,
} from "@/lib/workspace-nav";

describe("workspace shell routing", () => {
  it("treats only the homepage as marketing", () => {
    expect(isMarketingPath("/")).toBe(true);
    expect(isMarketingPath("/documents")).toBe(false);
    expect(isWorkspacePath("/documents/abc/review")).toBe(true);
  });

  it("marks Documents active for repository aliases and document deep links", () => {
    const documents = WORKSPACE_NAV.find((item) => item.id === "documents")!;
    expect(isNavItemActive("/documents", documents)).toBe(true);
    expect(isNavItemActive("/repository", documents)).toBe(true);
    expect(isNavItemActive("/documents/doc-1", documents)).toBe(true);
    expect(isNavItemActive("/documents/doc-1/review", documents)).toBe(true);
    expect(isNavItemActive("/extraction/new", documents)).toBe(false);
  });

  it("marks Extraction active for extraction routes only", () => {
    const extraction = WORKSPACE_NAV.find((item) => item.id === "extraction")!;
    expect(isNavItemActive("/extraction/new", extraction)).toBe(true);
    expect(isNavItemActive("/extraction", extraction)).toBe(true);
    expect(isNavItemActive("/documents", extraction)).toBe(false);
  });
});

describe("breadcrumbsForPath", () => {
  it("builds document and review crumbs with titles", () => {
    expect(breadcrumbsForPath("/documents/abc", { documentTitle: "Contract.pdf" })).toEqual([
      { label: "Workspace", href: "/documents" },
      { label: "Documents", href: "/documents" },
      { label: "Contract.pdf" },
    ]);
    expect(breadcrumbsForPath("/documents/abc/review", { documentTitle: "Contract.pdf" })).toEqual([
      { label: "Workspace", href: "/documents" },
      { label: "Documents", href: "/documents" },
      { label: "Contract.pdf", href: "/documents/abc" },
      { label: "Review" },
    ]);
  });

  it("includes family filter crumbs on the repository", () => {
    expect(breadcrumbsForPath("/documents", { search: "family=invoice" })).toEqual([
      { label: "Workspace", href: "/documents" },
      { label: "Documents", href: "/documents" },
      { label: "Invoice" },
    ]);
  });

  it("maps governance nested pages", () => {
    const crumbs = breadcrumbsForPath("/architecture");
    expect(crumbs.map((c) => c.label)).toEqual(["Workspace", "Governance", "Architecture"]);
  });
});
