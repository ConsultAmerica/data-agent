"use client";

import { useEffect, useState } from "react";

import { getCurrentActor } from "@/lib/auth";
import type { ActorInfo } from "@/types/document";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return ((parts[0][0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

const ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  reviewer: "Reviewer",
  analyst: "Analyst",
  viewer: "Viewer",
  workspace: "Workspace",
};

/** The signed-in identity: initials avatar plus role ("Guest" when the API
 * doesn't resolve one). */
export default function UserChip({ showRole = true }: { showRole?: boolean }) {
  const [actor, setActor] = useState<ActorInfo | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    getCurrentActor()
      .then((result) => {
        if (active) setActor(result);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const name = actor?.display_name || (failed ? "Guest" : "");
  const role = actor ? (ROLE_LABEL[actor.role] ?? actor.role) : failed ? "Guest" : "";
  const label = actor ? `${actor.display_name} · ${role}` : failed ? "Guest" : "Loading profile";

  return (
    <span
      className="inline-flex shrink-0 items-center gap-2 rounded-full border border-white/10 py-0.5 pl-0.5 pr-0.5 text-[11px] text-white/85 2xl:pr-2.5"
      title={actor?.email ? `${label} — ${actor.email}` : label}
      data-testid="user-chip"
    >
      <span
        aria-hidden="true"
        className="flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-[#22c4e0] to-[#0a6eb4] text-[10px] font-semibold text-white"
      >
        {name ? initials(name) : ""}
      </span>
      <span className="sr-only">{label}</span>
      {showRole && role && <span className="hidden whitespace-nowrap 2xl:inline" aria-hidden="true">{role}</span>}
    </span>
  );
}
