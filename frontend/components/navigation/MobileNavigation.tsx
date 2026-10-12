"use client";

import Link from "next/link";
import { Plus, Sparkles, X } from "lucide-react";

import DataAgentLogo from "@/components/navigation/data-agent-logo";
import MegaMenu from "@/components/navigation/MegaMenu";
import { TOP_MENUS } from "@/components/navigation/nav-config";

interface MobileNavigationProps {
  open: boolean;
  onClose: () => void;
}

export default function MobileNavigation({
  open,
  onClose,
}: MobileNavigationProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] lg:hidden">
      <button
        type="button"
        aria-label="Close navigation"
        className="absolute inset-0 bg-sirion-bg-deep/70 backdrop-blur-sm"
        onClick={onClose}
      />

      <aside className="absolute inset-y-0 left-0 flex w-[min(100%,360px)] flex-col bg-menu-background shadow-2xl">
        <div className="flex items-center justify-between border-b border-black/5 px-5 py-4">
          <div className="flex min-w-0 items-center">
            <DataAgentLogo variant="wordmark" tone="onLight" size={36} />
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-text-dark hover:bg-menu-tile"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <div className="space-y-2.5 pb-2">
            <Link
              href="/extraction/new"
              onClick={onClose}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-black/10 bg-black/5 px-4 py-3 text-sm font-semibold text-text-dark transition hover:bg-black/10 dark:border-white/15 dark:bg-white/5 dark:text-white dark:hover:bg-white/10"
            >
              <Plus className="h-4 w-4 shrink-0" strokeWidth={2} />
              <span className="whitespace-nowrap">New Document</span>
            </Link>

            <Link
              href="/ask"
              onClick={onClose}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-white transition hover:bg-primary-deep"
            >
              <Sparkles className="h-4 w-4 shrink-0" strokeWidth={1.75} />
              <span className="whitespace-nowrap">Ask Data Agent</span>
            </Link>
          </div>

          {TOP_MENUS.map((menu, index) => (
            <div key={menu.id} className={["space-y-4", index === 0 ? "border-t border-black/5 pt-4" : ""].join(" ")}>
              <Link
                href={menu.href}
                onClick={onClose}
                className="flex items-center justify-between px-1 text-xs font-semibold uppercase tracking-wider text-text-teal hover:text-primary"
              >
                {menu.label}
                <span className="text-[11px] font-medium normal-case tracking-normal">Overview →</span>
              </Link>
              <MegaMenu overviewTitle={menu.label} sections={menu.sections} onNavigate={onClose} />
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
