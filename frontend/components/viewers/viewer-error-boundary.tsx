"use client";

import { AlertTriangle, FileQuestion } from "lucide-react";
import { Component, type ReactNode } from "react";

/**
 * Contains a format viewer's failure: the rest of the review workspace
 * keeps working, and the user gets the fallback (page text) with the reason.
 */
export class ViewerErrorBoundary extends Component<
  { fallback: ReactNode; resetKey?: string; children: ReactNode },
  { failed: string | null; key?: string }
> {
  state: { failed: string | null; key?: string } = { failed: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown) {
    return { failed: error instanceof Error ? error.message : "The viewer stopped." };
  }

  static getDerivedStateFromProps(props: { resetKey?: string }, state: { failed: string | null; key?: string }) {
    // A different document (or view) gets a fresh attempt.
    return props.resetKey !== state.key ? { failed: null, key: props.resetKey } : null;
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="flex h-full min-h-0 flex-col" data-testid="viewer-error">
          <p className="flex items-start gap-1.5 border-b border-warning/30 bg-warning/10 px-3 py-1.5 text-[11px] text-text-secondary" role="alert">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" aria-hidden="true" />
            This view couldn&apos;t be shown ({this.state.failed}); showing the page text instead.
          </p>
          <div className="min-h-0 flex-1">{this.props.fallback}</div>
        </div>
      );
    }
    return this.props.children;
  }
}

/** A file that has no preview, and why. */
export function UnsupportedPreview({ note }: { note?: string | null }) {
  return (
    <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border p-6 text-center text-sm text-text-muted"
      data-testid="document-viewer" data-viewer="unsupported">
      <FileQuestion className="h-6 w-6" aria-hidden="true" />
      <p>This document can&apos;t be previewed.</p>
      {note && <p className="text-xs">{note}</p>}
    </div>
  );
}
