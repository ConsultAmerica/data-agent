"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";

import { useDocumentChrome } from "@/components/layout/document-chrome-context";
import { useRecentDocuments } from "@/lib/recent-documents";
import { breadcrumbsForPath, type BreadcrumbCrumb } from "@/lib/workspace-nav";

export default function Breadcrumbs({
  crumbs: override,
}: {
  crumbs?: BreadcrumbCrumb[];
}) {
  const pathname = usePathname() || "/";
  const searchParams = useSearchParams();
  const { documentTitle } = useDocumentChrome();
  // The document this page is about: a /documents/[id] route, or ?documentId=.
  const documentId =
    pathname.match(/^\/documents\/([^/]+)/)?.[1] ?? searchParams?.get("documentId")?.trim() ?? null;
  // Until the page loads the filename, name it from this browser's recent
  // documents (empty during server render and hydration).
  const recent = useRecentDocuments();
  const recentName = documentId ? (recent.find((item) => item.id === documentId)?.name ?? null) : null;
  const crumbs =
    override ??
    breadcrumbsForPath(pathname, {
      documentTitle: documentTitle || recentName,
      search: searchParams?.toString() ?? "",
    });

  if (crumbs.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className="workspace-breadcrumbs" data-testid="breadcrumbs">
      <ol className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-text-secondary">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <li key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-1">
              {index > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-text-muted" aria-hidden="true" />}
              {last || !crumb.href ? (
                <span
                  className="truncate font-medium text-foreground"
                  aria-current={last ? "page" : undefined}
                >
                  {crumb.label}
                </span>
              ) : (
                <Link href={crumb.href} className="truncate hover:text-primary">
                  {crumb.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
