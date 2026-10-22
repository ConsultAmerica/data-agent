"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight, ChevronDown, Plus, Sparkles, X } from "lucide-react";

import DataAgentLogo from "@/components/navigation/data-agent-logo";
import { TOP_MENUS, type TopMenu } from "@/components/navigation/nav-config";

interface MobileNavigationProps {
  open: boolean;
  onClose: () => void;
}

function pathOf(href: string) {
  return href.split(/[?#]/)[0];
}

/** The menu that owns the current page opens first; otherwise Documents. */
function menuForPath(pathname: string): TopMenu["id"] {
  const owner = TOP_MENUS.find(
    (menu) =>
      pathOf(menu.href) === pathname ||
      menu.sections.some((section) => section.tiles.some((tile) => pathOf(tile.href) === pathname)),
  );
  return owner?.id ?? TOP_MENUS[0].id;
}

/** Phone / tablet navigation: one column of collapsible sections with
 * compact rows, instead of the desktop mega-menu's two-column grid. */
export default function MobileNavigation({ open, onClose }: MobileNavigationProps) {
  // Mounted only while open, so each opening starts on the current page's section.
  return open ? <Drawer onClose={onClose} /> : null;
}

function Drawer({ onClose }: { onClose: () => void }) {
  const pathname = usePathname() || "/";
  const [expanded, setExpanded] = useState<TopMenu["id"] | null>(() => menuForPath(pathname));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // The page behind must not scroll while the drawer is open.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[100] lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
      <button
        type="button"
        aria-label="Close navigation"
        className="absolute inset-0 bg-sirion-bg-deep/70 backdrop-blur-sm"
        onClick={onClose}
      />

      <aside className="absolute inset-y-0 left-0 flex w-[min(100vw,22rem)] flex-col overflow-hidden bg-surface shadow-2xl sm:w-[24rem]">
        <div className="flex items-center justify-between border-b border-border px-4 py-3.5">
          <div className="flex min-w-0 items-center">
            <DataAgentLogo variant="wordmark" tone="onLight" size={36} />
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-text-dark hover:bg-surface-soft"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-6 pt-3" aria-label="Site">
          <div className="grid grid-cols-2 gap-2 pb-3">
            <Link
              href="/extraction/new"
              onClick={onClose}
              className="flex items-center justify-center gap-1.5 rounded-xl border border-border bg-surface-soft px-3 py-2.5 text-sm font-semibold text-text-dark"
            >
              <Plus className="h-4 w-4 shrink-0" strokeWidth={2} />
              <span className="truncate">New document</span>
            </Link>
            <Link
              href="/ask"
              onClick={onClose}
              className="flex items-center justify-center gap-1.5 rounded-xl bg-primary px-3 py-2.5 text-sm font-semibold text-white"
            >
              <Sparkles className="h-4 w-4 shrink-0" strokeWidth={1.75} />
              <span className="truncate">Ask Dataomatix</span>
            </Link>
          </div>

          <ul className="divide-y divide-border border-t border-border">
            {TOP_MENUS.map((menu) => {
              const isOpen = expanded === menu.id;
              const panelId = `mobile-menu-${menu.id}`;
              return (
                <li key={menu.id}>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    onClick={() => setExpanded(isOpen ? null : menu.id)}
                    className="flex w-full items-center justify-between gap-3 px-1 py-3 text-left"
                  >
                    <span className="min-w-0">
                      <span className="block text-[15px] font-semibold text-text-dark">{menu.label}</span>
                      <span className="block truncate text-xs text-text-muted">{menu.description}</span>
                    </span>
                    <ChevronDown
                      className={`h-4 w-4 shrink-0 text-text-muted transition-transform ${isOpen ? "rotate-180" : ""}`}
                      aria-hidden="true"
                    />
                  </button>
                  {isOpen && (
                    <div id={panelId} className="space-y-3 pb-4">
                      {menu.sections.map((section) => (
                        <div key={section.title}>
                          <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                            {section.title}
                          </p>
                          <ul className="space-y-0.5">
                            {section.tiles.map((tile) => {
                              const active = pathOf(tile.href) === pathname;
                              return (
                                <li key={`${tile.href}:${tile.label}`}>
                                  <Link
                                    href={tile.href}
                                    onClick={onClose}
                                    aria-current={active ? "page" : undefined}
                                    className={[
                                      "flex items-center gap-3 rounded-lg px-2 py-2",
                                      active ? "bg-primary-soft" : "hover:bg-surface-soft",
                                    ].join(" ")}
                                  >
                                    <span
                                      className={[
                                        "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                                        active ? "bg-primary text-white" : "bg-surface-soft text-primary",
                                      ].join(" ")}
                                    >
                                      <tile.icon className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                      <span className="block truncate text-sm font-medium text-text-dark">{tile.label}</span>
                                      {tile.description && (
                                        <span className="block truncate text-xs text-text-muted">{tile.description}</span>
                                      )}
                                    </span>
                                  </Link>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      ))}
                      <Link
                        href={menu.href}
                        onClick={onClose}
                        className="inline-flex items-center gap-1 px-1 text-xs font-semibold text-primary"
                      >
                        {menu.label} overview
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>
      </aside>
    </div>
  );
}
