"use client";

import { Suspense } from "react";

import ContentSection from "@/components/layout/ContentSection";
import { LoadingState } from "@/components/layout/StatusState";
import InsightsSearch from "@/components/search/insights-search";

export default function SearchPage() {
  return (
    <ContentSection>
      <Suspense fallback={<LoadingState title="Loading search…" />}>
        <InsightsSearch />
      </Suspense>
    </ContentSection>
  );
}
