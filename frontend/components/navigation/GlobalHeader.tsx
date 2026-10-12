"use client";

import Link from "next/link";
import { Bell, Menu, Plus, Search, Sparkles } from "lucide-react";
import { useState } from "react";
import { usePathname } from "next/navigation";

import BackendStatusPill from "@/components/navigation/BackendStatusPill";
import DataAgentLogo from "@/components/navigation/data-agent-logo";
import MobileNavigation from "@/components/navigation/MobileNavigation";
import NavDropdown from "@/components/navigation/NavDropdown";
import { TOP_MENUS, menuForPath, type TopMenu } from "@/components/navigation/nav-config";

function MenuItem({ menu, active }: { menu: TopMenu; active: TopMenu["id"] | null }) {
  return <NavDropdown label={menu.label} href={menu.href} sections={menu.sections} current={active === menu.id} />;
}

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
          <Link href="/" className="header-brand-link" aria-label="Data Agent home">
            <DataAgentLogo variant="wordmark" tone="onDark" size={34} />
          </Link>
        </div>

        {/* Primary nav — Platform, Intelligence, Review stay visible */}
        <nav className="header-nav" aria-label="Main navigation">
          {TOP_MENUS.filter((menu) => menu.id !== "governance").map((menu) => (
            <MenuItem key={menu.id} menu={menu} active={active} />
          ))}
          <div className="header-nav-governance">
            <MenuItem menu={TOP_MENUS.find((menu) => menu.id === "governance")!} active={active} />
          </div>
          <div className="header-nav-more">
            <NavDropdown
              label="More"
              href="/governance"
              sections={TOP_MENUS.find((menu) => menu.id === "governance")!.sections}
            />
          </div>
        </nav>

        {/* Actions — never shrink, never wrap onto nav */}
        <div className="header-actions">
          <Link href="/extraction/new" className="btn-new-extraction shrink-0" title="New Document">
            <Plus className="h-4 w-4 shrink-0" strokeWidth={2} />
            <span className="header-action-label whitespace-nowrap">New Document</span>
          </Link>

          <Link href="/ask" className="btn-ask-agent shrink-0" title="Ask Data Agent">
            <Sparkles className="h-4 w-4 shrink-0" strokeWidth={1.75} />
            <span className="header-action-label whitespace-nowrap">Ask Data Agent</span>
          </Link>

          <button
            type="button"
            onClick={onOpenSearch}
            aria-label="Search"
            className="nav-icon-button shrink-0"
          >
            <Search className="h-4 w-4" strokeWidth={1.75} />
          </button>

          <button
            type="button"
            aria-label="Notifications"
            className="nav-icon-button shrink-0"
          >
            <Bell className="h-4 w-4" strokeWidth={1.75} />
          </button>

          <div className="flex shrink-0 items-center border-l border-white/10 pl-3">
            <BackendStatusPill />
          </div>
        </div>

        {/* Mobile / tablet triggers */}
        <div className="header-mobile-triggers">
          <BackendStatusPill />

          <button
            type="button"
            onClick={onOpenSearch}
            aria-label="Search"
            className="nav-icon-button"
          >
            <Search className="h-4 w-4" strokeWidth={1.75} />
          </button>

          <button
            type="button"
            aria-label="Notifications"
            className="nav-icon-button"
          >
            <Bell className="h-4 w-4" strokeWidth={1.75} />
          </button>

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
