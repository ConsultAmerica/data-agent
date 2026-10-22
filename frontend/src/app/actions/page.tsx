"use client";

import { Suspense } from "react";

import ActionCatalog from "@/components/actions/action-catalog";
import ContentSection from "@/components/layout/ContentSection";
import PageHero from "@/components/layout/PageHero";

export default function ActionsPage() {
  return (
    <>
      <PageHero
        compact
        eyebrow="Intelligence & AI"
        title="Agent actions"
        description="One-click reports over a document — executive summary, risk register, clause gaps, obligations and funding — built only from extracted, source-cited data."
      />
      <ContentSection>
        <Suspense fallback={null}>
          <ActionCatalog />
        </Suspense>
      </ContentSection>
    </>
  );
}
