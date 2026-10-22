"use client";

import Link from "next/link";
import { ShieldAlert } from "lucide-react";

import { useDeployEnvironment } from "@/components/navigation/client-env";

/** Shown on hosted builds only (not on a local/self-hosted dev server):
 * where uploaded files actually go, so nobody sends controlled data. */
export default function HostedDataNotice({ className = "" }: { className?: string }) {
  const environment = useDeployEnvironment();
  if (!environment || environment === "Local") return null;

  return (
    <div
      role="note"
      className={`flex items-start gap-2.5 rounded-xl border border-warning/30 bg-warning/5 px-3.5 py-3 text-xs leading-5 text-text-secondary ${className}`}
      data-testid="hosted-data-notice"
    >
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
      <p>
        The hosted demo runs on commercial cloud. Files go to Supabase storage and data to Render
        Postgres. Don&apos;t upload CUI or other controlled information to it. Use the{" "}
        <Link href="/sample" className="font-medium text-primary underline-offset-2 hover:underline">
          sample contract
        </Link>
        , or self-host.
      </p>
    </div>
  );
}
