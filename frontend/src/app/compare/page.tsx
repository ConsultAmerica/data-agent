"use client";

import { Suspense } from "react";

import DocumentCompare from "@/components/compare/document-compare";
import ContentSection from "@/components/layout/ContentSection";
import PageHero from "@/components/layout/PageHero";

export default function ComparePage() {
  return (
    <>
      <PageHero
        compact
        eyebrow="Intelligence & AI"
        title="Compare documents"
        description="Put a modification next to its base award — or any two documents — and see which fields, CLINs, funding lines and clauses were added, removed or changed."
      />
      <ContentSection>
        <Suspense>
          <DocumentCompare />
        </Suspense>
      </ContentSection>
    </>
  );
}
