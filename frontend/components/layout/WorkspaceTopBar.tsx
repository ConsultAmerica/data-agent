"use client";

import Link from "next/link";
import { Menu, Plus, Sparkles } from "lucide-react";

import DataomatixLogo from "@/components/navigation/dataomatix-logo";
import BackendStatusPill from "@/components/navigation/BackendStatusPill";
import CommandTrigger from "@/components/navigation/command-trigger";
import UserChip from "@/components/navigation/user-chip";

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
          aria-label="Toggle navigation"
          aria-controls="workspace-sidebar"
          onClick={onOpenMobileNav}
        >
          <Menu className="h-4 w-4" strokeWidth={1.75} />
        </button>
        <Link href="/" className="header-brand-link" aria-label="Dataomatix home">
          <DataomatixLogo variant="wordmark" tone="onDark" size={36} />
        </Link>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
        <Link href="/extraction/new" className="btn-new-extraction shrink-0" title="New Document">
          <Plus className="h-4 w-4 shrink-0" strokeWidth={2} />
          <span className="header-action-label whitespace-nowrap">New Document</span>
        </Link>
        <Link href="/ask" className="btn-ask-agent shrink-0" title="DataoAI">
          <Sparkles className="h-4 w-4 shrink-0" strokeWidth={1.75} />
          <span className="header-action-label whitespace-nowrap">Ask</span>
        </Link>
        {/* Search pill with its shortcut from tablet width; a plain icon on phones. */}
        <span className="hidden md:inline-flex">
          <CommandTrigger onOpen={onOpenSearch} />
        </span>
        <span className="md:hidden">
          <CommandTrigger onOpen={onOpenSearch} compact />
        </span>
        <div className="hidden shrink-0 items-center gap-2 border-l border-white/10 pl-2 sm:flex">
          <BackendStatusPill labelClassName="hidden lg:inline" />
          <UserChip />
        </div>
      </div>
    </header>
  );
}
