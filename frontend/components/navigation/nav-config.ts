import type { LucideIcon } from "lucide-react";
import {
  Activity,
  AlertTriangle,
  Archive,
  CircleAlert,
  FileText,
  GraduationCap,
  LayoutGrid,
  Mail,
  Receipt,
  Upload,
  BarChart3,
  BookCheck,
  Bot,
  CalendarClock,
  ClipboardList,
  Compass,
  FileSearch,
  GitBranch,
  GitCompare,
  GitCompareArrows,
  History,
  Layers,
  Lightbulb,
  ListChecks,
  ScrollText,
  Search,
  Settings,
  Sparkles,
  Workflow,
} from "lucide-react";

export interface NavTile {
  label: string;
  description?: string;
  href: string;
  icon: LucideIcon;
}

export interface MegaMenuSection {
  title: string;
  tiles: NavTile[];
}

export const DOCUMENTS_SECTIONS: MegaMenuSection[] = [
  {
    title: "Documents",
    tiles: [
      {
        label: "All documents",
        description: "Every document in your workspace",
        href: "/documents",
        icon: Archive,
      },
      {
        label: "Needs review",
        description: "Values to confirm",
        href: "/documents?filter=review",
        icon: ListChecks,
      },
      {
        label: "Failed",
        description: "Processing did not complete",
        href: "/documents?filter=failed",
        icon: CircleAlert,
      },
      {
        label: "Upload document",
        description: "Add a document",
        href: "/extraction/new",
        icon: Upload,
      },
    ],
  },
  {
    title: "By type",
    tiles: [
      { label: "Invoices", href: "/documents?family=invoice", icon: Receipt },
      { label: "Transcripts & certificates", href: "/documents?family=academic_transcript", icon: GraduationCap },
      { label: "Contracts", href: "/documents?family=government_contract", icon: FileText },
      { label: "FAR regulations", href: "/documents?family=far_regulation", icon: ScrollText },
      { label: "Correspondence", href: "/documents?family=correspondence", icon: Mail },
    ],
  },
];

export const PLATFORM_SECTIONS: MegaMenuSection[] = [
  {
    title: "Workspace",
    tiles: [
      { label: "Documents", description: "Browse documents", href: "/documents", icon: Archive },
      { label: "New Document", description: "Upload & extract", href: "/extraction/new", icon: FileSearch },
      { label: "Field Explorer", description: "Compare extracted fields", href: "/explorer", icon: Compass },
      { label: "Review", description: "Resolve items needing attention", href: "/review-queue", icon: ListChecks },
    ],
  },
  {
    title: "Intelligence",
    tiles: [
      { label: "DataoAI", description: "Query document data", href: "/ask", icon: Sparkles },
      { label: "Search", description: "Search documents and fields", href: "/search", icon: Search },
      { label: "Analytics", description: "Portfolio insights", href: "/analytics", icon: BarChart3 },
      { label: "Obligations", description: "Deliverables and deadlines", href: "/obligations", icon: CalendarClock },
      { label: "Agent Actions", description: "Summaries, risk and funding reports", href: "/actions", icon: Bot },
    ],
  },
];

export const INTELLIGENCE_SECTIONS: MegaMenuSection[] = [
  {
    title: "Document Intelligence",
    tiles: [
      {
        label: "Field Explorer",
        description: "Compare fields across documents",
        href: "/explorer",
        icon: Compass,
      },
      {
        label: "DataoAI",
        description: "Query document data",
        href: "/ask",
        icon: Sparkles,
      },
    ],
  },
  {
    title: "Contract Intelligence",
    tiles: [
      {
        label: "FAR / DFARS Clauses",
        description: "Clause intelligence",
        href: "/clauses",
        icon: ScrollText,
      },
      {
        label: "Clause Search",
        description: "Find provisions across contracts",
        href: "/clauses",
        icon: Search,
      },
      {
        label: "Clause Comparison",
        description: "Side-by-side comparison",
        href: "/clauses/compare",
        icon: GitCompare,
      },
      {
        label: "Document Compare",
        description: "Mod vs base award diff",
        href: "/compare",
        icon: GitCompareArrows,
      },
      {
        label: "Obligations",
        description: "Deliverables, reports and due dates",
        href: "/obligations",
        icon: CalendarClock,
      },
      {
        label: "Agent Actions",
        description: "One-click contract reports",
        href: "/actions",
        icon: Bot,
      },
      {
        label: "Relationships",
        description: "Contract hierarchy and lineage",
        href: "/relationships",
        icon: GitBranch,
      },
      {
        label: "Contract Insights",
        description: "Executive summaries",
        href: "/insights",
        icon: Lightbulb,
      },
    ],
  },
];

export const REVIEW_SECTIONS: MegaMenuSection[] = [
  {
    title: "Review",
    tiles: [
      {
        label: "Review",
        description: "Items needing a decision",
        href: "/review-queue",
        icon: ListChecks,
      },
      {
        label: "Recent Extractions",
        description: "Latest processed documents",
        href: "/#recent-extractions",
        icon: Archive,
      },
      {
        label: "Human Review History",
        description: "Audit trail of review actions",
        href: "/audit-log",
        icon: History,
      },
      {
        label: "Activity Feed",
        description: "Recent review and edit actions",
        href: "/activity",
        icon: Activity,
      },
    ],
  },
];

export const GOVERNANCE_SECTIONS: MegaMenuSection[] = [
  {
    title: "Governance",
    tiles: [
      {
        label: "Architecture",
        description: "Platform lifecycle and topology",
        href: "/architecture",
        icon: Layers,
      },
      {
        label: "Integration Center",
        description: "Workflows and approved data",
        href: "/integrations",
        icon: Workflow,
      },
      {
        label: "Audit Log",
        description: "Every review and edit action",
        href: "/audit-log",
        icon: ClipboardList,
      },
      {
        label: "Settings",
        description: "Application settings",
        href: "/settings",
        icon: Settings,
      },
      {
        label: "Clause Playbook",
        description: "Expected and prohibited clauses",
        href: "/playbook",
        icon: BookCheck,
      },
      {
        label: "Risk",
        description: "Obligations and compliance gaps",
        href: "/risk",
        icon: AlertTriangle,
      },
    ],
  },
];

export const OVERVIEW_LINKS = [
  { label: "Dataomatix", href: "/", icon: Sparkles },
];

export interface TopMenu {
  id: "documents" | "platform" | "intelligence" | "review" | "governance";
  label: string;
  /** The hub the label itself opens. */
  href: string;
  description: string;
  sections: MegaMenuSection[];
}

export const TOP_MENUS: TopMenu[] = [
  {
    id: "documents",
    label: "Documents",
    href: "/documents",
    description: "Every document, by status and type.",
    sections: DOCUMENTS_SECTIONS,
  },
  {
    id: "platform",
    label: "Platform",
    href: "/platform",
    description: "Upload, extract, explore and analyze documents.",
    sections: PLATFORM_SECTIONS,
  },
  {
    id: "intelligence",
    label: "Intelligence",
    href: "/intelligence",
    description: "Cross-document answers, clause intelligence and contract insights.",
    sections: INTELLIGENCE_SECTIONS,
  },
  {
    id: "review",
    label: "Review",
    href: "/review",
    description: "Human review of extracted values and the record of every decision.",
    sections: REVIEW_SECTIONS,
  },
  {
    id: "governance",
    label: "Governance",
    href: "/governance",
    description: "Risk, audit, integrations, architecture and settings.",
    sections: GOVERNANCE_SECTIONS,
  },
];

export function topMenu(id: TopMenu["id"]): TopMenu {
  return TOP_MENUS.find((menu) => menu.id === id) as TopMenu;
}

export const HUB_ICON = LayoutGrid;

/** The one top menu a page belongs to (so a single button is filled): its
 * own hub page first, else the first menu, left to right, linking to it. */
export function menuForPath(pathname: string): TopMenu["id"] | null {
  if (!pathname || pathname === "/") return null;
  const hub = TOP_MENUS.find((menu) => menu.href === pathname);
  if (hub) return hub.id;
  const owner = TOP_MENUS.find((menu) =>
    menu.sections.some((section) => section.tiles.some((tile) => tile.href.split(/[?#]/)[0] === pathname)),
  );
  return owner?.id ?? null;
}
