"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  Archive,
  BarChart3,
  BookCheck,
  Bot,
  CalendarClock,
  CalendarX2,
  ClipboardList,
  Compass,
  FileSearch,
  GitCompareArrows,
  LayoutGrid,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  ScrollText,
  Settings,
  Sparkles,
  Workflow,
  type LucideIcon,
} from "lucide-react";

import {
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
  governance: ClipboardList,
  settings: Settings,
};

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
  // Collapsed rail: the hovered/focused item's name, drawn outside the
  // scrolling list (which would clip it) at the item's height.
  const [tip, setTip] = useState<{ label: string; top: number } | null>(null);
  const showTip = (label: string, element: HTMLElement) => {
    if (!collapsed) return;
    const box = element.getBoundingClientRect();
    setTip({ label, top: box.top + box.height / 2 });
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

        <nav className="workspace-sidebar-nav" aria-label="Primary" onScroll={() => setTip(null)}>
          <ul className="workspace-sidebar-list">
            {WORKSPACE_NAV.map((item) => (
              <SidebarItem
                key={item.id}
                item={item}
                collapsed={collapsed}
                active={isNavItemActive(pathname, item)}
                onNavigate={() => {
                  setTip(null);
                  onMobileClose();
                }}
                onHint={showTip}
                onHintEnd={() => setTip(null)}
              />
            ))}
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
  onNavigate,
  onHint,
  onHintEnd,
}: {
  item: WorkspaceNavItem;
  collapsed: boolean;
  active: boolean;
  onNavigate: () => void;
  onHint: (label: string, element: HTMLElement) => void;
  onHintEnd: () => void;
}) {
  const Icon = ICONS[item.id];
  return (
    <li>
      {item.group &&
        (collapsed ? (
          <span className="workspace-sidebar-divider" aria-hidden="true" />
        ) : (
          <p className="workspace-sidebar-group" aria-hidden="true">
            {item.group}
          </p>
        ))}
      <Link
        href={item.href}
        onClick={onNavigate}
        onMouseEnter={(event) => onHint(item.label, event.currentTarget)}
        onMouseLeave={onHintEnd}
        onFocus={(event) => onHint(item.label, event.currentTarget)}
        onBlur={onHintEnd}
        aria-current={active ? "page" : undefined}
        className={["workspace-sidebar-link", active ? "workspace-sidebar-link-active" : ""].join(" ")}
        data-testid={`nav-${item.id}`}
      >
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" strokeWidth={1.75} />
        <span className={collapsed ? "sr-only" : "truncate"}>{item.label}</span>
      </Link>
    </li>
  );
}
