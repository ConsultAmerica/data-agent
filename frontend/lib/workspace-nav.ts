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
  | "search"
  | "analytics"
  | "clauses"
  | "obligations"
  | "expirations"
  | "compare"
  | "actions"
  | "playbook"
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

/** Sidebar group labels, in order. Items are grouped by the job a person
 * is doing, not by how the backend is built. */
export const WORKSPACE_NAV_GROUPS = [
  "Workspace",
  "Document Processing",
  "Intelligence & AI",
  "Compliance & Controls",
  "Administration",
] as const;

/** Primary sidebar destinations — keep compact; specialized tools follow. */
export const WORKSPACE_NAV: WorkspaceNavItem[] = [
  { id: "overview", label: "Overview", href: "/platform", group: "Workspace" },
  // Document Processing: getting documents in, extracted and reviewed.
  {
    id: "documents",
    label: "Documents",
    href: "/documents",
    match: ["/documents", "/repository"],
    group: "Document Processing",
  },
  { id: "extraction", label: "Extraction", href: "/extraction/new", match: ["/extraction"] },
  { id: "review", label: "Review queue", href: "/review-queue", match: ["/review-queue", "/review"] },
  // Intelligence & AI: asking, finding and comparing what the documents say.
  { id: "ask", label: "DataoAI", href: "/ask", group: "Intelligence & AI" },
  { id: "search", label: "Search", href: "/search" },
  { id: "clauses", label: "FAR / DFARS", href: "/clauses", match: ["/clauses"] },
  { id: "explorer", label: "Field Explorer", href: "/explorer" },
  { id: "compare", label: "Compare", href: "/compare" },
  { id: "actions", label: "Agent actions", href: "/actions" },
  {
    id: "analytics",
    label: "Analytics",
    href: "/analytics",
    match: ["/analytics", "/insights", "/relationships"],
  },
  // Compliance & Controls: what contracts owe, the rules they are held to,
  // and what leaves the system.
  { id: "obligations", label: "Obligations", href: "/obligations", group: "Compliance & Controls" },
  { id: "expirations", label: "Expirations", href: "/expirations" },
  { id: "playbook", label: "Clause playbook", href: "/playbook" },
  { id: "integrations", label: "Exports & Oracle", href: "/integrations" },
  // Administration: audit, access and configuration.
  {
    id: "governance",
    label: "Governance",
    href: "/governance",
    match: ["/governance", "/architecture", "/audit-log", "/activity", "/risk"],
    group: "Administration",
  },
  { id: "settings", label: "Settings", href: "/settings", match: ["/settings", "/api-keys"] },
];

const MARKETING_PATHS = new Set(["/", "/sample"]);

/** Homepage and the public sample keep the marketing shell; every other route uses the workspace shell. */
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
    // Back to the list the person came from (filters, sort and page kept).
    const returnQs = params.get("return");
    crumbs.push({ label: "Documents", href: returnQs ? `/documents?${returnQs}` : "/documents" });
    const title = options?.documentTitle?.trim() || "Document";
    const docHref = `/documents/${documentMatch[1]}`;
    const subview =
      documentMatch[2] === "review"
        ? "Review"
        : params.get("panel") === "oracle"
          ? "Oracle"
          : DOCUMENT_VIEW_CRUMBS[params.get("view") ?? ""];
    if (subview) {
      crumbs.push({ label: title, href: docHref });
      crumbs.push({ label: subview });
    } else {
      crumbs.push({ label: title });
    }
    return crumbs;
  }

  if (path === "/integrations" && params.get("documentId")) {
    return [
      ...crumbs,
      { label: "Exports & Oracle", href: "/integrations" },
      { label: options?.documentTitle?.trim() || "Document" },
    ];
  }

  if (path === "/clauses" && params.get("q")?.trim()) {
    return [...crumbs, { label: "FAR / DFARS", href: "/clauses" }, { label: params.get("q")!.trim() }];
  }

  const staticMap: Record<string, BreadcrumbCrumb[]> = {
    "/platform": [...crumbs, { label: "Overview" }],
    "/extraction": [...crumbs, { label: "Extraction" }],
    "/extraction/new": [...crumbs, { label: "Extraction", href: "/extraction" }, { label: "New batch" }],
    "/review-queue": [...crumbs, { label: "Review queue" }],
    "/review": [...crumbs, { label: "Review" }],
    "/explorer": [...crumbs, { label: "Field Explorer" }],
    "/ask": [...crumbs, { label: "DataoAI" }],
    "/search": [...crumbs, { label: "Search" }],
    "/clauses": [...crumbs, { label: "FAR / DFARS" }],
    "/obligations": [...crumbs, { label: "Obligations" }],
    "/expirations": [...crumbs, { label: "Expirations" }],
    "/compare": [...crumbs, { label: "Compare" }],
    "/actions": [...crumbs, { label: "Agent actions" }],
    "/playbook": [...crumbs, { label: "Clause playbook" }],
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

  return staticMap[path] ?? [...crumbs, ...fallbackCrumbs(path)];
}

/** ?view= tabs of the document workspace that deserve their own crumb
 * (the default Summary tab doesn't). */
const DOCUMENT_VIEW_CRUMBS: Record<string, string> = {
  overview: "Overview",
  source: "Source",
  canonical: "Canonical",
  transform: "Transform",
  data: "Data",
  qa: "QA",
};

/** Unmapped routes: one clickable crumb per segment, title-cased. */
function fallbackCrumbs(path: string): BreadcrumbCrumb[] {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return [{ label: "Page" }];
  return segments.map((segment, index) => {
    const label = decodeURIComponent(segment)
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
    const last = index === segments.length - 1;
    return last ? { label } : { label, href: `/${segments.slice(0, index + 1).join("/")}` };
  });
}

export const SIDEBAR_COLLAPSED_KEY = "da-sidebar-collapsed";
