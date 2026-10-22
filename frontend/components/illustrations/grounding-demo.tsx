"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { CornerDownRight } from "lucide-react";

interface DemoField {
  label: string;
  value: string;
  confidence: number;
  /** Text as it appears on the mock source page. */
  source: string;
  /** Set when review routing sends the field to the queue. */
  reviewReason?: string;
}

// Values, scores and routing match the pipeline output for the public
// sample contract (lib/sample/sample-extraction.json).
const FIELDS: DemoField[] = [
  {
    label: "Contract No.",
    value: "W91ZZZ26C0042",
    confidence: 0.85,
    source: "2. CONTRACT NUMBER W91ZZZ26C0042",
  },
  {
    label: "Award date",
    value: "08/19/2026",
    confidence: 0.85,
    source: "3. AWARD/EFFECTIVE DATE 08/19/2026",
  },
  {
    label: "Total award",
    value: "$1,250,000.00",
    confidence: 0.85,
    source: "26. TOTAL AWARD AMOUNT $1,250,000.00",
  },
  {
    label: "FAR clause",
    value: "52.212-4",
    confidence: 0.8,
    source: "52.212-4 CONTRACT TERMS AND CONDITIONS",
  },
  {
    label: "Issued by",
    value: "2 candidates",
    confidence: 0.5,
    source: "9. ISSUED BY Sample Contracting Activity / 100 Example Way",
    reviewReason: "Ambiguous candidates",
  },
];

const STEP_MS = 1100;
/** Extra beats held on the finished state before the loop restarts. */
const HOLD_STEPS = 3;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function usePrefersReducedMotion() {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false,
  );
}

export default function GroundingDemo() {
  const reducedMotion = usePrefersReducedMotion();
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (reducedMotion) return;
    const id = window.setInterval(() => {
      setStep((s) => (s + 1) % (FIELDS.length + 1 + HOLD_STEPS));
    }, STEP_MS);
    return () => window.clearInterval(id);
  }, [reducedMotion]);

  // Number of fields extracted so far; the most recent one is "active".
  const shown = reducedMotion ? FIELDS.length : Math.min(step, FIELDS.length);
  const activeIndex = shown > 0 && shown <= FIELDS.length ? shown - 1 : -1;
  const routed = FIELDS.find((f, i) => i < shown && f.reviewReason);

  return (
    <div className="grounding-demo" aria-hidden="true">
      <ol className="grounding-fields">
        {FIELDS.map((field, i) => {
          const visible = i < shown;
          const low = Boolean(field.reviewReason);
          return (
            <li
              key={field.label}
              className={[
                "grounding-field",
                visible ? "is-visible" : "",
                i === activeIndex ? "is-active" : "",
                low ? "is-low" : "",
              ].join(" ")}
            >
              <span className="grounding-field-label">
                <span className="grounding-marker">{i + 1}</span>
                {field.label}
              </span>
              <span className="grounding-field-value">
                {visible ? field.value : " "}
              </span>
              <span className="grounding-field-conf">
                {visible ? `${Math.round(field.confidence * 100)}%` : ""}
              </span>
            </li>
          );
        })}
        <li
          className={[
            "grounding-routed",
            routed ? "is-visible" : "",
          ].join(" ")}
        >
          <CornerDownRight className="h-3.5 w-3.5 shrink-0" />
          Review queue · {routed?.reviewReason ?? " "}
        </li>
      </ol>

      <div className="grounding-page">
        <div className="grounding-page-head">
          <span>SF 1449 · p. 1</span>
          <span>sample-contract.pdf</span>
        </div>
        <div className="grounding-line w-3/4" />
        {FIELDS.map((field, i) => (
          <div key={field.label}>
            <div
              className={[
                "grounding-box",
                i < shown ? "is-boxed" : "",
                i === activeIndex ? "is-active" : "",
                field.reviewReason ? "is-low" : "",
              ].join(" ")}
            >
              <span className="grounding-marker">{i + 1}</span>
              {field.source}
            </div>
            <div className="grounding-line w-11/12" />
            <div className="grounding-line w-2/3" />
          </div>
        ))}
      </div>
    </div>
  );
}
