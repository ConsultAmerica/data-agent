import Link from "next/link";
import { ArrowRight, FileSearch, Upload } from "lucide-react";

export default function NextStepBand() {
  return (
    <section className="next-step-band" aria-labelledby="next-step-title">
      <div className="next-step-grid" aria-hidden="true" />
      <div className="marketing-band-inner relative z-[1] py-16 lg:py-20">
        <h2 id="next-step-title" className="next-step-title">
          Ready for your <span className="text-gradient-accent">next step?</span>
        </h2>
        <div className="mt-10 grid gap-5 md:grid-cols-2">
          <div className="next-step-card">
            <h3 className="next-step-card-title">Walk the review loop</h3>
            <p className="next-step-card-body">
              Open the sample contract, resolve the flagged values, watch the audit trail fill in,
              and run the export dry run. No sign-up, nothing uploaded.
            </p>
            <Link href="/sample" className="btn-hero-primary mt-6">
              <FileSearch className="h-4 w-4 shrink-0" />
              Open the sample contract
            </Link>
          </div>
          <div className="next-step-card">
            <h3 className="next-step-card-title">Run your own contract</h3>
            <p className="next-step-card-body">
              Upload an award, solicitation or modification and get a staging workbook with every
              value tied to its page. For controlled information, self-host it in your own boundary.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
              <Link href="/extraction/new" className="btn-hero-secondary">
                <Upload className="h-4 w-4 shrink-0" />
                Start an extraction
              </Link>
              <Link href="/#trust" className="next-step-link">
                Deployment options
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
