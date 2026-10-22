"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, FileSearch, Upload } from "lucide-react";

import AgentRunMockup from "@/components/marketing/agent-run-mockup";

const SLIDES = [
  {
    id: "extract",
    label: "Extract",
    caption:
      "Every value is boxed on its source page. Low-confidence fields route to a reviewer.",
    image: "/brand/hero/hero-extract.jpg",
    durationMs: 7000,
  },
  {
    id: "review",
    label: "Review",
    caption: "A reviewer resolves the flagged value; the decision is logged before anything ships.",
    image: "/brand/hero/hero-review.jpg",
    durationMs: 5600,
  },
  {
    id: "govern",
    label: "Govern",
    caption: "Only reviewed values are staged for the Oracle export, and live sends stay off by default.",
    image: "/brand/hero/hero-govern.jpg",
    durationMs: 5600,
  },
] as const;

interface HeroShowcaseProps {
  brand?: ReactNode;
  /** Small mono pill above the headline. */
  eyebrow?: string;
  title: ReactNode;
  description: string;
}

export default function HeroShowcase({
  brand,
  eyebrow,
  title,
  description,
}: HeroShowcaseProps) {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const id = window.setTimeout(() => {
      setActive((i) => (i + 1) % SLIDES.length);
    }, SLIDES[active].durationMs);
    return () => window.clearTimeout(id);
  }, [active, paused]);

  const slide = SLIDES[active];

  return (
    <section
      className="hero-showcase"
      aria-roledescription="carousel"
      aria-label="Dataomatix product highlights"
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
          {eyebrow && <p className="hero-eyebrow-pill reveal-up">{eyebrow}</p>}
          <h1 className="page-hero-title reveal-up reveal-up-delay-1">{title}</h1>
          <p className="page-hero-description reveal-up reveal-up-delay-2">
            {description}
          </p>
          <div className="page-hero-actions reveal-up reveal-up-delay-3">
            <Link href="/extraction/new" className="btn-hero-primary">
              <Upload className="h-4 w-4 shrink-0" />
              <span className="whitespace-nowrap">Start extraction</span>
            </Link>
            <Link href="/sample" className="btn-hero-secondary">
              <FileSearch className="h-4 w-4 shrink-0" />
              <span className="whitespace-nowrap">Open a sample contract</span>
              <ArrowRight className="h-4 w-4 shrink-0" />
            </Link>
          </div>
        </div>

        <div className="hero-showcase-stage hero-showcase-stage-wide reveal-up reveal-up-delay-2">
          <div id={`hero-panel-${slide.id}`} className="w-full" aria-live="polite">
            <AgentRunMockup stage={active as 0 | 1 | 2} />
            <p className="hero-agent-caption">
              <span className="hero-agent-caption-label">{slide.label}</span>
              {slide.caption}
            </p>
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
                    ? { animationDuration: `${item.durationMs}ms` }
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
