"use client";

import { Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

import GlobalSearch, { useGlobalSearchShortcut } from "@/components/global-search";
import Breadcrumbs from "@/components/layout/Breadcrumbs";
import { DocumentChromeProvider } from "@/components/layout/document-chrome-context";
import SidebarNavigation from "@/components/layout/SidebarNavigation";
import WorkspaceTopBar from "@/components/layout/WorkspaceTopBar";
import GlobalHeader from "@/components/navigation/GlobalHeader";
import { SIDEBAR_COLLAPSED_KEY, isMarketingPath } from "@/lib/workspace-nav";

interface AppShellProps {
  children: ReactNode;
}

function readCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export default function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const marketing = isMarketingPath(pathname);
  const [searchOpen, setSearchOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  useGlobalSearchShortcut(openSearch);

  useEffect(() => {
    setCollapsed(readCollapsed());
  }, []);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  function handleCollapsedChange(next: boolean) {
    setCollapsed(next);
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // private mode / blocked storage — collapse still works in-session
    }
  }

  if (marketing) {
    return (
      <div className="marketing-shell flex h-full min-h-0 flex-col" data-testid="marketing-shell">
        <GlobalHeader onOpenSearch={openSearch} />
        <main className="min-h-0 flex-1 overflow-y-auto bg-background">{children}</main>
        <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
      </div>
    );
  }

  return (
    <DocumentChromeProvider>
      <div className="workspace-shell flex h-full min-h-0 flex-col" data-testid="workspace-shell">
        <WorkspaceTopBar
          onOpenSearch={openSearch}
          onOpenMobileNav={() => setMobileNavOpen(true)}
        />
        <div className="workspace-body flex min-h-0 flex-1">
          <SidebarNavigation
            collapsed={collapsed}
            mobileOpen={mobileNavOpen}
            onCollapsedChange={handleCollapsedChange}
            onMobileClose={() => setMobileNavOpen(false)}
          />
          <div className="workspace-main flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-[var(--color-page)]">
            <div className="workspace-chrome-bar">
              <Suspense fallback={<div className="h-4" aria-hidden="true" />}>
                <Breadcrumbs />
              </Suspense>
            </div>
            <main className="workspace-content min-h-0 flex-1">{children}</main>
          </div>
        </div>
        <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
      </div>
    </DocumentChromeProvider>
  );
}
