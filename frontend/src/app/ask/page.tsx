"use client";

import { Suspense } from "react";

import AskWorkspace from "@/components/ask/ask-workspace";
import { LoadingState } from "@/components/layout/StatusState";

export default function AskPage() {
  return (
    <Suspense
      fallback={
        <LoadingState
          title="Loading Ask Dataomatix..."
          description="Connecting to extracted data and source pages."
        />
      }
    >
      <AskWorkspace />
    </Suspense>
  );
}
