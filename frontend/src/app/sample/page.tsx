import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Upload } from "lucide-react";

import ContentSection from "@/components/layout/ContentSection";
import PageHero from "@/components/layout/PageHero";
import SampleContractViewer from "@/components/sample/sample-contract-viewer";

export const metadata: Metadata = {
  title: "Sample contract",
  description:
    "Open a sample federal contract and see every extracted value boxed on its source page, the fields routed to review, and the audit trail your decisions create.",
};

export default function SamplePage() {
  return (
    <>
      <PageHero
        compact
        eyebrow="Sample contract"
        title="Check every value against the page it came from."
        description="A fictional SF 1449 award, run through the real extraction pipeline. Pick a field to see its source box, resolve the ones routed to review, and watch the audit trail and export gate respond."
        actions={
          <>
            <Link href="/extraction/new" className="btn-hero-primary">
              <Upload className="h-4 w-4" />
              Try your own contract
            </Link>
            <Link href="/#confidence" className="btn-hero-secondary">
              How confidence works
              <ArrowRight className="h-4 w-4" />
            </Link>
          </>
        }
      />
      <ContentSection wide>
        <SampleContractViewer />
      </ContentSection>
    </>
  );
}
