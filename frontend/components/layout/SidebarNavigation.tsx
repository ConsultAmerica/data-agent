"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import {
  Archive,
  BarChart3,
  BookCheck,
  Bot,
  CalendarClock,
  CalendarX2,
  ChevronDown,
  ClipboardList,
  Compass,
  FileSearch,
  GitCompareArrows,
  LayoutGrid,
  ListChecks,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  ScrollText,
  Settings,
  Sparkles,
  LayoutTemplate,
  ShieldQuestion,
  Shuffle,
  Workflow,
  type LucideIcon,
} from "lucide-react";

import { getDocumentStatusCounts } from "@/lib/documents";
import {
  SIDEBAR_FOLDED_GROUPS_KEY,
  WORKSPACE_NAV,
  isNavItemActive,
  type WorkspaceNavId,
  type WorkspaceNavItem,
} from "@/lib/workspace-nav";

const ICONS: Record<WorkspaceNavId, LucideIcon> = {
  overview: LayoutGrid,
  documents: Archive,
  extraction: FileSearch,
  review: ListChecks,
  classification: ShieldQuestion,
  schemas: LayoutTemplate,
  explorer: Compass,
  ask: Sparkles,
  search: Search,
  analytics: BarChart3,
  clauses: ScrollText,
  obligations: CalendarClock,
  expirations: CalendarX2,
  compare: GitCompareArrows,
  actions: Bot,
  playbook: BookCheck,
  integrations: Workflow,
  mapping: Shuffle,
  governance: ClipboardList,
  settings: Settings,
};

type NavBadge = { count: number; tone: "attention" | "live"; label: string };

type NavGroup = { name: string; items: WorkspaceNavItem[] };

/** WORKSPACE_NAV marks only a group's first item; bucket the rest under it. */
function groupNav(items: WorkspaceNavItem[]): NavGroup[] {
  const groups: NavGroup[] = [];
  for (const item of items) {
    if (item.group || groups.length === 0) groups.push({ name: item.group ?? "", items: [] });
    groups[groups.length - 1].items.push(item);
  }
  return groups;
}

const NAV_GROUPS = groupNav(WORKSPACE_NAV);
const BADGE_REFRESH_MS = 60_000;

// Folded groups are a per-person preference kept in localStorage, read as
// an external store so the server render (nothing folded) hydrates cleanly.
const FOLDED_EVENT = "da-sidebar-folded-change";

function subscribeFolded(onChange: () => void) {
  window.addEventListener(FOLDED_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(FOLDED_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readFoldedRaw(): string {
  try {
    return window.localStorage.getItem(SIDEBAR_FOLDED_GROUPS_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

function parseFolded(raw: string): Set<string> {
  try {
    const value: unknown = JSON.parse(raw);
    return new Set(Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
  } catch {
    return new Set();
  }
}

function useFoldedGroups(): [Set<string>, (name: string) => void] {
  const raw = useSyncExternalStore(subscribeFolded, readFoldedRaw, () => "[]");
  const folded = useMemo(() => parseFolded(raw), [raw]);
  const toggle = useCallback((name: string) => {
    const next = parseFolded(readFoldedRaw());
    if (next.has(name)) next.delete(name);
    else next.add(name);
    try {
      window.localStorage.setItem(SIDEBAR_FOLDED_GROUPS_KEY, JSON.stringify([...next]));
    } catch {
      // blocked storage — nothing to persist to; the group stays as it was
    }
    window.dispatchEvent(new Event(FOLDED_EVENT));
  }, []);
  return [folded, toggle];
}

/** Documents waiting on a reviewer, and documents still extracting: the two
 * numbers that tell someone where work is waiting. Failures stay silent —
 * the pages themselves report outages. */
function useNavBadges(pathname: string): Partial<Record<WorkspaceNavId, NavBadge>> {
  const [counts, setCounts] = useState<{ review: number; processing: number } | null>(null);

  useEffect(() => {
    let active = true;
    const load = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      getDocumentStatusCounts()
        .then(({ by_status }) => {
          if (active) {
            setCounts({ review: by_status.review_required ?? 0, processing: by_status.processing ?? 0 });
          }
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, BADGE_REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
    // Refetched on navigation so a finished review clears its badge.
  }, [pathname]);

  return useMemo(() => {
    if (!counts) return {};
    const badges: Partial<Record<WorkspaceNavId, NavBadge>> = {};
    if (counts.review > 0) {
      badges.review = {
        count: counts.review,
        tone: "attention",
        label: `${counts.review} ${counts.review === 1 ? "document needs" : "documents need"} review`,
      };
    }
    if (counts.processing > 0) {
      badges.extraction = {
        count: counts.processing,
        tone: "live",
        label: `${counts.processing} ${counts.processing === 1 ? "document is" : "documents are"} processing`,
      };
    }
    return badges;
  }, [counts]);
}

interface SidebarNavigationProps {
  collapsed: boolean;
  mobileOpen: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onMobileClose: () => void;
}

export default function SidebarNavigation({
  collapsed,
  mobileOpen,
  onCollapsedChange,
  onMobileClose,
}: SidebarNavigationProps) {
  const pathname = usePathname() || "/";
  const badges = useNavBadges(pathname);
  const navRef = useRef<HTMLElement>(null);
  // Collapsed rail: the hovered/focused item's name, drawn outside the
  // scrolling list (which would clip it) at the item's height.
  const [tip, setTip] = useState<{ label: string; top: number } | null>(null);
  const showTip = (label: string, element: HTMLElement) => {
    if (!collapsed) return;
    const box = element.getBoundingClientRect();
    setTip({ label, top: box.top + box.height / 2 });
  };

  const [folded, toggleGroup] = useFoldedGroups();

  // Fade the list's top/bottom edge only when there is more to scroll to.
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const measureEdges = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;
    const top = nav.scrollTop > 2;
    const bottom = nav.scrollTop + nav.clientHeight < nav.scrollHeight - 2;
    setEdges((current) => (current.top === top && current.bottom === bottom ? current : { top, bottom }));
  }, []);
  useEffect(() => {
    measureEdges();
    const nav = navRef.current;
    if (!nav || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureEdges);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [measureEdges, collapsed, folded]);

  // Keep the current page's entry in view (deep links, small screens).
  useEffect(() => {
    const active = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    active?.scrollIntoView?.({ block: "nearest" });
  }, [pathname, collapsed]);

  // Arrow keys move between entries; Home/End jump to the ends.
  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const focusables = Array.from(
      navRef.current?.querySelectorAll<HTMLElement>(".workspace-sidebar-link, .workspace-sidebar-group") ?? [],
    );
    const index = focusables.indexOf(document.activeElement as HTMLElement);
    if (index === -1) return;
    event.preventDefault();
    const last = focusables.length - 1;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? last
          : event.key === "ArrowDown"
            ? Math.min(index + 1, last)
            : Math.max(index - 1, 0);
    focusables[next]?.focus();
  }

  const navigate = () => {
    setTip(null);
    onMobileClose();
  };

  return (
    <>
      {mobileOpen && (
        <button
          type="button"
          className="workspace-sidebar-backdrop lg:hidden"
          aria-label="Close navigation"
          onClick={onMobileClose}
        />
      )}
      <aside
        id="workspace-sidebar"
        data-testid="workspace-sidebar"
        data-collapsed={collapsed ? "true" : "false"}
        data-mobile-open={mobileOpen ? "true" : "false"}
        className={[
          "workspace-sidebar",
          collapsed ? "workspace-sidebar-collapsed" : "",
          mobileOpen ? "workspace-sidebar-mobile-open" : "",
        ].join(" ")}
        aria-label="Workspace"
      >
        <div className="workspace-sidebar-tools">
          <button
            type="button"
            className="workspace-sidebar-toggle"
            aria-expanded={!collapsed}
            aria-controls="workspace-sidebar"
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => onCollapsedChange(!collapsed)}
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
            ) : (
              <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
            )}
            <span className="sr-only">{collapsed ? "Expand sidebar" : "Collapse sidebar"}</span>
          </button>
        </div>

        <nav
          ref={navRef}
          className="workspace-sidebar-nav"
          aria-label="Primary"
          data-fade-top={edges.top ? "true" : undefined}
          data-fade-bottom={edges.bottom ? "true" : undefined}
          onScroll={() => {
            setTip(null);
            measureEdges();
          }}
          onKeyDown={handleKeyDown}
        >
          <ul className="workspace-sidebar-list">
            {NAV_GROUPS.map((group, groupIndex) => {
              // The rail has no group labels to fold, so it shows everything.
              const isFolded = !collapsed && folded.has(group.name);
              const groupId = `workspace-sidebar-group-${groupIndex}`;
              const groupBadges = group.items.filter((item) => badges[item.id]).length;
              // A folded group still shows the page you are on.
              const visible = isFolded
                ? group.items.filter((item) => isNavItemActive(pathname, item))
                : group.items;
              return (
                <li key={group.name || groupIndex}>
                  {group.name &&
                    (collapsed ? (
                      groupIndex > 0 && <span className="workspace-sidebar-divider" aria-hidden="true" />
                    ) : (
                      <button
                        type="button"
                        className="workspace-sidebar-group"
                        aria-expanded={!isFolded}
                        aria-controls={groupId}
                        onClick={() => toggleGroup(group.name)}
                        title={isFolded ? `Show ${group.name}` : `Hide ${group.name}`}
                      >
                        <span className="truncate">{group.name}</span>
                        {isFolded && groupBadges > 0 && (
                          <span className="workspace-sidebar-group-dot" aria-label="Has items waiting" />
                        )}
                        <ChevronDown className="workspace-sidebar-group-chevron" aria-hidden="true" />
                      </button>
                    ))}
                  <ul id={groupId} className="workspace-sidebar-sublist">
                    {visible.map((item) => (
                      <SidebarItem
                        key={item.id}
                        item={item}
                        collapsed={collapsed}
                        active={isNavItemActive(pathname, item)}
                        badge={badges[item.id]}
                        onNavigate={navigate}
                        onHint={showTip}
                        onHintEnd={() => setTip(null)}
                      />
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        </nav>

        {collapsed && tip && (
          <span className="workspace-sidebar-tooltip" style={{ top: tip.top }} role="presentation">
            {tip.label}
          </span>
        )}

        {!collapsed && (
          <p className="workspace-sidebar-footnote">
            <BarChart3 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Document intelligence workspace
          </p>
        )}
      </aside>
    </>
  );
}

function SidebarItem({
  item,
  collapsed,
  active,
  badge,
  onNavigate,
  onHint,
  onHintEnd,
}: {
  item: WorkspaceNavItem;
  collapsed: boolean;
  active: boolean;
  badge?: NavBadge;
  onNavigate: () => void;
  onHint: (label: string, element: HTMLElement) => void;
  onHintEnd: () => void;
}) {
  const Icon = ICONS[item.id];
  const hint = badge ? `${item.label} · ${badge.label}` : item.label;
  return (
    <li>
      <Link
        href={item.href}
        onClick={onNavigate}
        onMouseEnter={(event) => onHint(hint, event.currentTarget)}
        onMouseLeave={onHintEnd}
        onFocus={(event) => onHint(hint, event.currentTarget)}
        onBlur={onHintEnd}
        aria-current={active ? "page" : undefined}
        className={["workspace-sidebar-link", active ? "workspace-sidebar-link-active" : ""].join(" ")}
        data-testid={`nav-${item.id}`}
      >
        <span className="workspace-sidebar-icon">
          <Icon className="h-4 w-4 shrink-0" aria-hidden="true" strokeWidth={1.75} />
          <PendingSpinner />
          {collapsed && badge && (
            <span className={`workspace-sidebar-badge-dot workspace-sidebar-badge-${badge.tone}`} aria-hidden="true" />
          )}
        </span>
        <span className={collapsed ? "sr-only" : "min-w-0 flex-1 truncate"}>{item.label}</span>
        {badge &&
          (collapsed ? (
            <span className="sr-only">{badge.label}</span>
          ) : (
            <span
              className={`workspace-sidebar-badge workspace-sidebar-badge-${badge.tone}`}
              title={badge.label}
              aria-label={badge.label}
              data-testid={`nav-badge-${item.id}`}
            >
              {badge.count > 99 ? "99+" : badge.count}
            </span>
          ))}
      </Link>
    </li>
  );
}

/** Replaces the icon while the clicked route is still loading, so a slow
 * navigation never looks like an ignored click. Always rendered (opacity
 * toggles) so the row never shifts. */
function PendingSpinner() {
  const { pending } = useLinkStatus();
  return (
    <span className="workspace-sidebar-pending" data-pending={pending ? "true" : undefined} aria-hidden="true">
      <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
    </span>
  );
}
