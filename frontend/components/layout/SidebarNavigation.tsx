"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Archive,
  BarChart3,
  ClipboardList,
  Compass,
  FileSearch,
  LayoutGrid,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
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
  clauses: ScrollText,
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

        <nav className="workspace-sidebar-nav" aria-label="Primary">
          <ul className="workspace-sidebar-list">
            {WORKSPACE_NAV.map((item) => (
              <SidebarItem
                key={item.id}
                item={item}
                collapsed={collapsed}
                active={isNavItemActive(pathname, item)}
                onNavigate={onMobileClose}
              />
            ))}
          </ul>
        </nav>

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
}: {
  item: WorkspaceNavItem;
  collapsed: boolean;
  active: boolean;
  onNavigate: () => void;
}) {
  const Icon = ICONS[item.id];
  return (
    <li>
      {item.group && !collapsed && (
        <p className="workspace-sidebar-group" aria-hidden="true">
          {item.group}
        </p>
      )}
      <Link
        href={item.href}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        title={collapsed ? item.label : undefined}
        className={["workspace-sidebar-link", active ? "workspace-sidebar-link-active" : ""].join(" ")}
        data-testid={`nav-${item.id}`}
      >
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" strokeWidth={1.75} />
        <span className={collapsed ? "sr-only" : "truncate"}>{item.label}</span>
      </Link>
    </li>
  );
}
