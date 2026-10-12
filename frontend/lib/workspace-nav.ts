/**
 * RC2-01 workspace information architecture.
 * Maps the approved IA onto existing routes — no deep links removed.
 */

export type WorkspaceNavId =
  | "overview"
  | "documents"
  | "extraction"
  | "review"
  | "explorer"
  | "ask"
  | "clauses"
  | "integrations"
  | "governance"
  | "settings";

export type WorkspaceNavItem = {
  id: WorkspaceNavId;
  label: string;
  href: string;
  /** Path prefixes that mark this item active (in addition to href). */
  match?: string[];
  /** Shown only when the sidebar is expanded (group label before this item). */
  group?: string;
};

/** Primary sidebar destinations — keep compact; specialized tools follow. */
export const WORKSPACE_NAV: WorkspaceNavItem[] = [
  { id: "overview", label: "Overview", href: "/platform", group: "Workspace" },
  {
    id: "documents",
    label: "Documents",
    href: "/documents",
    match: ["/documents", "/repository"],
  },
  { id: "extraction", label: "Extraction", href: "/extraction/new", match: ["/extraction"] },
  { id: "review", label: "Review Queue", href: "/review-queue", match: ["/review-queue", "/review"] },
  { id: "explorer", label: "Explorer", href: "/explorer" },
  { id: "ask", label: "Ask Data Agent", href: "/ask", group: "Intelligence" },
  { id: "clauses", label: "FAR / DFARS", href: "/clauses", match: ["/clauses"] },
  {
    id: "integrations",
    label: "Exports & Oracle",
    href: "/integrations",
    group: "Governance",
  },
  {
    id: "governance",
    label: "Governance",
    href: "/governance",
    match: ["/governance", "/architecture", "/audit-log", "/activity", "/risk", "/analytics", "/insights", "/relationships"],
  },
  { id: "settings", label: "Settings", href: "/settings", match: ["/settings", "/api-keys"] },
];

const MARKETING_PATHS = new Set(["/"]);

/** Homepage keeps the marketing shell; every other route uses the workspace shell. */
export function isMarketingPath(pathname: string | null | undefined): boolean {
  if (!pathname) return true;
  const path = pathname.split(/[?#]/)[0] || "/";
  return MARKETING_PATHS.has(path);
}

export function isWorkspacePath(pathname: string | null | undefined): boolean {
  return !isMarketingPath(pathname);
}

/** True when this nav item should show as the active destination. */
export function isNavItemActive(pathname: string, item: WorkspaceNavItem): boolean {
  const path = pathname.split(/[?#]/)[0] || "/";
  const candidates = [item.href, ...(item.match ?? [])];
  return candidates.some((candidate) => {
    const base = candidate.split(/[?#]/)[0];
    if (base === "/documents") {
      return path === "/documents" || path === "/repository" || path.startsWith("/documents/");
    }
    if (base === "/extraction" || base === "/extraction/new") {
      return path === "/extraction" || path.startsWith("/extraction/");
    }
    if (path === base) return true;
    if (base !== "/" && path.startsWith(`${base}/`)) return true;
    return false;
  });
}

export type BreadcrumbCrumb = {
  label: string;
  href?: string;
};

const FAMILY_CRUMBS: Record<string, string> = {
  invoice: "Invoice",
  academic_transcript: "Academic Transcript",
  government_contract: "Government Contract",
  far_regulation: "FAR Regulation",
  far_regulatory_change: "FAR Final Rule",
  xml_data: "FAR Clause XML",
  correspondence: "Correspondence",
  generic_business: "Generic Document",
};

/**
 * Build breadcrumbs from the URL. Optional documentTitle improves
 * /documents/[id] crumbs when the workspace has loaded a filename.
 */
export function breadcrumbsForPath(
  pathname: string,
  options?: { documentTitle?: string | null; search?: string },
): BreadcrumbCrumb[] {
  const path = pathname.split(/[?#]/)[0] || "/";
  const params = new URLSearchParams(options?.search ?? "");
  const crumbs: BreadcrumbCrumb[] = [{ label: "Workspace", href: "/documents" }];

  if (path === "/" || path === "") {
    return [{ label: "Home", href: "/" }];
  }

  if (path === "/documents" || path === "/repository") {
    crumbs.push({ label: "Documents" });
    const family = params.get("family");
    if (family && FAMILY_CRUMBS[family]) {
      crumbs[crumbs.length - 1] = { label: "Documents", href: "/documents" };
      crumbs.push({ label: FAMILY_CRUMBS[family] });
    }
    return crumbs;
  }

  const documentMatch = path.match(/^\/documents\/([^/]+)(?:\/(review))?$/);
  if (documentMatch) {
    crumbs.push({ label: "Documents", href: "/documents" });
    const title = options?.documentTitle?.trim() || "Document";
    const docHref = `/documents/${documentMatch[1]}`;
    if (documentMatch[2] === "review") {
      crumbs.push({ label: title, href: docHref });
      crumbs.push({ label: "Review" });
    } else {
      crumbs.push({ label: title });
    }
    return crumbs;
  }

  const staticMap: Record<string, BreadcrumbCrumb[]> = {
    "/platform": [...crumbs, { label: "Overview" }],
    "/extraction": [...crumbs, { label: "Extraction" }],
    "/extraction/new": [...crumbs, { label: "Extraction" }],
    "/review-queue": [...crumbs, { label: "Review Queue" }],
    "/review": [...crumbs, { label: "Review" }],
    "/explorer": [...crumbs, { label: "Explorer" }],
    "/ask": [...crumbs, { label: "Ask Data Agent" }],
    "/search": [...crumbs, { label: "Search" }],
    "/clauses": [...crumbs, { label: "FAR / DFARS" }],
    "/clauses/compare": [
      ...crumbs,
      { label: "FAR / DFARS", href: "/clauses" },
      { label: "Compare" },
    ],
    "/integrations": [...crumbs, { label: "Exports & Oracle" }],
    "/governance": [...crumbs, { label: "Governance" }],
    "/architecture": [
      ...crumbs,
      { label: "Governance", href: "/governance" },
      { label: "Architecture" },
    ],
    "/audit-log": [
      ...crumbs,
      { label: "Governance", href: "/governance" },
      { label: "Audit Log" },
    ],
    "/activity": [
      ...crumbs,
      { label: "Governance", href: "/governance" },
      { label: "Activity" },
    ],
    "/risk": [...crumbs, { label: "Governance", href: "/governance" }, { label: "Risk" }],
    "/analytics": [...crumbs, { label: "Analytics" }],
    "/insights": [...crumbs, { label: "Insights" }],
    "/relationships": [...crumbs, { label: "Relationships" }],
    "/settings": [...crumbs, { label: "Settings" }],
    "/settings/extraction-models": [
      ...crumbs,
      { label: "Settings", href: "/settings" },
      { label: "Extraction Models" },
    ],
    "/api-keys": [
      ...crumbs,
      { label: "Settings", href: "/settings" },
      { label: "API Keys" },
    ],
    "/intelligence": [...crumbs, { label: "Intelligence" }],
  };

  return staticMap[path] ?? [...crumbs, { label: path.split("/").filter(Boolean).pop() || "Page" }];
}

export const SIDEBAR_COLLAPSED_KEY = "da-sidebar-collapsed";
