import { describe, expect, it } from "vitest";

import {
  WORKSPACE_NAV,
  WORKSPACE_NAV_GROUPS,
  breadcrumbsForPath,
  isMarketingPath,
  isNavItemActive,
  isWorkspacePath,
} from "@/lib/workspace-nav";

describe("workspace shell routing", () => {
  it("treats the homepage and public sample as marketing", () => {
    expect(isMarketingPath("/")).toBe(true);
    expect(isMarketingPath("/sample")).toBe(true);
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

describe("sidebar grouping", () => {
  it("highlights Analytics, not Governance, for portfolio analytics pages", () => {
    const analytics = WORKSPACE_NAV.find((item) => item.id === "analytics")!;
    const governance = WORKSPACE_NAV.find((item) => item.id === "governance")!;
    for (const path of ["/analytics", "/insights", "/relationships"]) {
      expect(isNavItemActive(path, analytics)).toBe(true);
      expect(isNavItemActive(path, governance)).toBe(false);
    }
    expect(isNavItemActive("/audit-log", governance)).toBe(true);
  });

  it("lists Search and groups items by persona", () => {
    expect(WORKSPACE_NAV.some((item) => item.href === "/search")).toBe(true);
    expect(WORKSPACE_NAV.filter((item) => item.group).map((item) => item.group)).toEqual([...WORKSPACE_NAV_GROUPS]);
    const groupOf = (id: string) => {
      let current = "";
      for (const item of WORKSPACE_NAV) {
        if (item.group) current = item.group;
        if (item.id === id) return current;
      }
      return null;
    };
    expect(["documents", "extraction", "review"].map(groupOf)).toEqual(Array(3).fill("Document Processing"));
    expect(["ask", "search", "clauses", "explorer", "compare"].map(groupOf)).toEqual(Array(5).fill("Intelligence & AI"));
    expect(["obligations", "playbook", "integrations"].map(groupOf)).toEqual(Array(3).fill("Compliance & Controls"));
    // Exactly one item is active on any page.
    for (const path of ["/analytics", "/search", "/playbook", "/explorer", "/documents/x/review"]) {
      expect(WORKSPACE_NAV.filter((item) => isNavItemActive(path, item)).length, path).toBeLessThanOrEqual(1);
    }
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

  it("returns to the filtered list and names the document sub-view", () => {
    expect(
      breadcrumbsForPath("/documents/abc", { documentTitle: "Contract.pdf", search: "view=source&return=filter%3Dreview" }),
    ).toEqual([
      { label: "Workspace", href: "/documents" },
      { label: "Documents", href: "/documents?filter=review" },
      { label: "Contract.pdf", href: "/documents/abc" },
      { label: "Source" },
    ]);
    expect(breadcrumbsForPath("/documents/abc", { documentTitle: "C.pdf", search: "panel=oracle" }).at(-1)).toEqual({
      label: "Oracle",
    });
    // The default Summary tab gets no extra crumb.
    expect(breadcrumbsForPath("/documents/abc", { documentTitle: "C.pdf", search: "view=staging" }).at(-1)).toEqual({
      label: "C.pdf",
    });
  });

  it("names the Oracle document, the clause query and unmapped routes", () => {
    expect(breadcrumbsForPath("/integrations", { documentTitle: "Award.pdf", search: "documentId=abc" })).toEqual([
      { label: "Workspace", href: "/documents" },
      { label: "Exports & Oracle", href: "/integrations" },
      { label: "Award.pdf" },
    ]);
    expect(breadcrumbsForPath("/clauses", { search: "q=252.204-7012" }).map((c) => c.label)).toEqual([
      "Workspace",
      "FAR / DFARS",
      "252.204-7012",
    ]);
    expect(breadcrumbsForPath("/extraction/new").map((c) => c.label)).toEqual(["Workspace", "Extraction", "New batch"]);
    expect(breadcrumbsForPath("/some-area/deep_page")).toEqual([
      { label: "Workspace", href: "/documents" },
      { label: "Some Area", href: "/some-area" },
      { label: "Deep Page" },
    ]);
  });

  it("maps governance nested pages", () => {
    const crumbs = breadcrumbsForPath("/architecture");
    expect(crumbs.map((c) => c.label)).toEqual(["Workspace", "Governance", "Architecture"]);
  });
});
