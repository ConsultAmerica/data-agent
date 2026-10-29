"use client";

import Link from "next/link";
import { Menu, Plus, Sparkles } from "lucide-react";
import { useState } from "react";
import { usePathname } from "next/navigation";

import CommandTrigger from "@/components/navigation/command-trigger";
import DataomatixLogo from "@/components/navigation/dataomatix-logo";
import MobileNavigation from "@/components/navigation/MobileNavigation";
import NavDropdown from "@/components/navigation/NavDropdown";
import UserChip from "@/components/navigation/user-chip";
import { TOP_MENUS, menuForPath } from "@/components/navigation/nav-config";

interface GlobalHeaderProps {
  onOpenSearch: () => void;
}

export default function GlobalHeader({ onOpenSearch }: GlobalHeaderProps) {
  const active = menuForPath(usePathname());
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      <header className="global-header app-header shrink-0">
        {/* Brand — never shrink */}
        <div className="header-left">
          <Link href="/" className="header-brand-link" aria-label="Dataomatix home">
            <DataomatixLogo variant="wordmark" tone="onDark" size={42} />
          </Link>
        </div>

        {/* Section pills. All five always render; when the header is tight the
            row scrolls sideways (snapping to a pill) instead of hiding any. */}
        <nav aria-label="Main navigation" className="hidden min-w-0 flex-1 lg:flex">
          <div className="scrollbar-none flex min-w-0 snap-x snap-mandatory items-center gap-1 overflow-x-auto py-1 2xl:gap-1.5">
            {TOP_MENUS.map((menu) => (
              <NavDropdown
                key={menu.id}
                label={menu.label}
                href={menu.href}
                sections={menu.sections}
                current={active === menu.id}
              />
            ))}
          </div>
        </nav>

        {/* Actions — never shrink, never wrap onto nav */}
        <div className="header-actions">
          <Link href="/extraction/new" className="btn-new-extraction shrink-0" title="New Document">
            <Plus className="h-4 w-4 shrink-0" strokeWidth={2} />
            <span className="header-action-label whitespace-nowrap">New Document</span>
          </Link>

          <Link href="/ask" className="btn-ask-agent shrink-0" title="DataoAI">
            <Sparkles className="h-4 w-4 shrink-0" strokeWidth={1.75} />
            <span className="header-action-label whitespace-nowrap">DataoAI</span>
          </Link>

          <CommandTrigger onOpen={onOpenSearch} kbdClassName="hidden xl:inline" labelClassName="hidden 2xl:inline" />

          {/* The public header stays lean: the profile only (no backend status
              or environment; connection problems surface where they matter). */}
          <div className="flex shrink-0 items-center gap-2 border-l border-white/10 pl-3">
            <span className="hidden xl:inline-flex">
              <UserChip showRole={false} />
            </span>
          </div>
        </div>

        {/* Phones and tablets: logo, search and the menu (profile from
            tablet width up). */}
        <div className="header-mobile-triggers">
          <span className="hidden items-center gap-2 sm:flex">
            <UserChip showRole={false} />
          </span>
          <CommandTrigger onOpen={onOpenSearch} compact />
          <button
            type="button"
            className="nav-icon-button"
            aria-label="Open menu"
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>
      </header>

      <MobileNavigation open={mobileOpen} onClose={() => setMobileOpen(false)} />
    </>
  );
}
