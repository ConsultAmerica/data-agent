"use client";

import Link from "next/link";
import { Bell, Menu, Plus, Search, Sparkles } from "lucide-react";

import DataAgentLogo from "@/components/navigation/data-agent-logo";
import BackendStatusPill from "@/components/navigation/BackendStatusPill";

interface WorkspaceTopBarProps {
  onOpenSearch: () => void;
  onOpenMobileNav: () => void;
}

/** Compact chrome for workspace routes — no mega-menu (sidebar owns IA). */
export default function WorkspaceTopBar({ onOpenSearch, onOpenMobileNav }: WorkspaceTopBarProps) {
  return (
    <header className="workspace-topbar" data-testid="workspace-topbar">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          className="nav-icon-button lg:hidden"
          aria-label="Open navigation"
          aria-controls="workspace-sidebar"
          onClick={onOpenMobileNav}
        >
          <Menu className="h-4 w-4" strokeWidth={1.75} />
        </button>
        <Link href="/documents" className="header-brand-link" aria-label="Data Agent documents">
          <DataAgentLogo variant="wordmark" tone="onDark" size={30} />
        </Link>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
        <Link href="/extraction/new" className="btn-new-extraction shrink-0" title="New Document">
          <Plus className="h-4 w-4 shrink-0" strokeWidth={2} />
          <span className="header-action-label whitespace-nowrap">New Document</span>
        </Link>
        <Link href="/ask" className="btn-ask-agent shrink-0" title="Ask Data Agent">
          <Sparkles className="h-4 w-4 shrink-0" strokeWidth={1.75} />
          <span className="header-action-label whitespace-nowrap">Ask</span>
        </Link>
        <button type="button" onClick={onOpenSearch} aria-label="Search" className="nav-icon-button shrink-0">
          <Search className="h-4 w-4" strokeWidth={1.75} />
        </button>
        <button type="button" aria-label="Notifications" className="nav-icon-button shrink-0">
          <Bell className="h-4 w-4" strokeWidth={1.75} />
        </button>
        <div className="hidden shrink-0 items-center border-l border-white/10 pl-2 sm:flex">
          <BackendStatusPill />
        </div>
      </div>
    </header>
  );
}
