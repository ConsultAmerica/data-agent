"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowRight,
  CheckCheck,
  FileSearch,
  ShieldCheck,
  Sparkles,
  Upload,
} from "lucide-react";

const SLIDES = [
  {
    id: "extract",
    label: "Extract",
    caption: "Source-grounded fields from every page",
    image: "/brand/hero/hero-extract.jpg",
    panel: "extract" as const,
  },
  {
    id: "review",
    label: "Review",
    caption: "Human verification before anything ships",
    image: "/brand/hero/hero-review.jpg",
    panel: "review" as const,
  },
  {
    id: "govern",
    label: "Govern",
    caption: "Audit-ready paths into enterprise systems",
    image: "/brand/hero/hero-govern.jpg",
    panel: "govern" as const,
  },
] as const;

const INTERVAL_MS = 5600;

interface HeroShowcaseProps {
  brand?: ReactNode;
  title: ReactNode;
  description: string;
}

export default function HeroShowcase({
  brand,
  title,
  description,
}: HeroShowcaseProps) {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const id = window.setInterval(() => {
      setActive((i) => (i + 1) % SLIDES.length);
    }, INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [paused]);

  const slide = SLIDES[active];

  return (
    <section
      className="hero-showcase"
      aria-roledescription="carousel"
      aria-label="Data Agent product highlights"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setPaused(false);
        }
      }}
    >
      <div className="hero-showcase-media" aria-hidden="true">
        {SLIDES.map((item, index) => (
          <div
            key={item.id}
            className={[
              "hero-showcase-slide",
              index === active ? "hero-showcase-slide-active" : "",
            ].join(" ")}
          >
            <Image
              src={item.image}
              alt=""
              fill
              priority={index === 0}
              sizes="100vw"
              className="hero-showcase-image"
            />
          </div>
        ))}
        <div className="hero-showcase-scrim" />
      </div>

      <div className="hero-showcase-inner">
        <div className="hero-showcase-copy">
          {brand && <div className="page-hero-brand reveal-up">{brand}</div>}
          <h1 className="page-hero-title reveal-up reveal-up-delay-1">{title}</h1>
          <p className="page-hero-description reveal-up reveal-up-delay-2">
            {description}
          </p>
          <div className="page-hero-actions reveal-up reveal-up-delay-3">
            <Link href="/extraction/new" className="btn-hero-primary">
              <Upload className="h-4 w-4 shrink-0" />
              <span className="whitespace-nowrap">Start extraction</span>
            </Link>
            <Link href="/ask" className="btn-hero-secondary">
              <Sparkles className="h-4 w-4 shrink-0" />
              <span className="whitespace-nowrap">Ask Data Agent</span>
              <ArrowRight className="h-4 w-4 shrink-0" />
            </Link>
          </div>
        </div>

        <div className="hero-showcase-stage reveal-up reveal-up-delay-2">
          <div
            key={slide.id}
            className="hero-stage-frame"
            aria-live="polite"
          >
            <div className="hero-stage-chrome">
              <span className="hero-stage-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span className="hero-stage-label">{slide.label}</span>
            </div>
            <div className="hero-stage-body">
              {slide.panel === "extract" && <ExtractPanel />}
              {slide.panel === "review" && <ReviewPanel />}
              {slide.panel === "govern" && <GovernPanel />}
            </div>
            <p className="hero-stage-caption">{slide.caption}</p>
          </div>
        </div>
      </div>

      <div className="hero-showcase-controls">
        <div className="hero-showcase-tabs" role="tablist" aria-label="Hero scenes">
          {SLIDES.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={index === active}
              aria-controls={`hero-panel-${item.id}`}
              className={[
                "hero-showcase-tab",
                index === active ? "hero-showcase-tab-active" : "",
              ].join(" ")}
              onClick={() => setActive(index)}
            >
              <span className="hero-showcase-tab-label">{item.label}</span>
              <span
                className="hero-showcase-tab-progress"
                style={
                  index === active && !paused
                    ? { animationDuration: `${INTERVAL_MS}ms` }
                    : undefined
                }
              />
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function ExtractPanel() {
  return (
    <div id="hero-panel-extract" className="hero-panel">
      <div className="hero-panel-row hero-panel-row-head">
        <FileSearch className="h-4 w-4 text-primary" strokeWidth={1.75} />
        <span>Contract W912HQ-24-C-0001</span>
        <span className="hero-panel-pill">Live extract</span>
      </div>
      {[
        ["Contract No.", "W912HQ-24-C-0001", "99%"],
        ["Award Date", "08/19/2026", "97%"],
        ["Total Value", "$1.25M", "94%"],
      ].map(([label, value, conf]) => (
        <div key={label} className="hero-panel-row">
          <span className="hero-panel-muted">{label}</span>
          <span className="hero-panel-value">{value}</span>
          <span className="hero-panel-conf">{conf}</span>
        </div>
      ))}
    </div>
  );
}

function ReviewPanel() {
  return (
    <div id="hero-panel-review" className="hero-panel">
      <div className="hero-panel-row hero-panel-row-head">
        <CheckCheck className="h-4 w-4 text-primary" strokeWidth={1.75} />
        <span>Review queue</span>
        <span className="hero-panel-pill hero-panel-pill-warn">3 need eyes</span>
      </div>
      {[
        ["Period of Performance", "Needs review"],
        ["Clause 52.212-4", "Verified"],
        ["Payment Terms", "Needs review"],
      ].map(([field, status]) => (
        <div key={field} className="hero-panel-row">
          <span className="hero-panel-muted">{field}</span>
          <span
            className={[
              "hero-panel-status",
              status === "Verified" ? "is-ok" : "is-warn",
            ].join(" ")}
          >
            {status}
          </span>
        </div>
      ))}
    </div>
  );
}

function GovernPanel() {
  return (
    <div id="hero-panel-govern" className="hero-panel">
      <div className="hero-panel-row hero-panel-row-head">
        <ShieldCheck className="h-4 w-4 text-primary" strokeWidth={1.75} />
        <span>Export readiness</span>
        <span className="hero-panel-pill">Oracle path</span>
      </div>
      {[
        ["Staging workbook", "Ready"],
        ["Audit trail", "Complete"],
        ["Dry-run preview", "Passed"],
      ].map(([item, status]) => (
        <div key={item} className="hero-panel-row">
          <span className="hero-panel-muted">{item}</span>
          <span className="hero-panel-status is-ok">{status}</span>
        </div>
      ))}
    </div>
  );
}
