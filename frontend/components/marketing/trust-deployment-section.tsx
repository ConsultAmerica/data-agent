import {
  Cpu,
  FileLock2,
  History,
  Landmark,
  Server,
  Workflow,
} from "lucide-react";

type Status = "available" | "configuration" | "not-yet";

const STATUS_COPY: Record<Status, { label: string; tone: string }> = {
  available: {
    label: "Available",
    tone: "border-success/30 bg-success/10 text-success",
  },
  configuration: {
    label: "Not yet validated",
    tone: "border-border bg-surface-soft text-text-secondary",
  },
  "not-yet": {
    label: "Not authorized",
    tone: "border-warning/40 bg-warning/10 text-warning",
  },
};

const ITEMS: {
  icon: typeof Cpu;
  title: string;
  body: string;
  status: Status;
}[] = [
  {
    icon: Workflow,
    title: "Deterministic first",
    body: "Form fields, CLINs, funding lines, and FAR/DFARS clauses come from rules and page layout, not a model. You can turn the AI fallback off entirely.",
    status: "available",
  },
  {
    icon: Cpu,
    title: "Bring your own model",
    body: "When the fallback is on, it calls Gemini, OpenAI, or a local Ollama model on your own endpoint. Ollama keeps document text on your network.",
    status: "available",
  },
  {
    icon: Server,
    title: "Self-host in your VPC",
    body: "The API and web app ship as Docker images behind nginx, so you can run them in your own cloud account, including GovCloud, with your own Postgres and storage.",
    status: "available",
  },
  {
    icon: History,
    title: "Audit trail",
    body: "Every review decision is append-only and records the reviewer's ID, role, the value before and after, the reason, and the time.",
    status: "available",
  },
  {
    icon: FileLock2,
    title: "Air-gapped operation",
    body: "With the AI fallback off or on Ollama, local Tesseract OCR, and local storage, no step needs the internet. It hasn't been tested inside an enclave yet.",
    status: "configuration",
  },
  {
    icon: Landmark,
    title: "FedRAMP",
    body: "Dataomatix has no FedRAMP authorization of its own. For federal workloads, deploy it inside an environment that already holds the ATO you need.",
    status: "not-yet",
  },
];

/** The route a federal buyer can take today. No dates: none are committed. */
const AUTHORIZATION_PATH: { step: string; detail: string; status: Status }[] = [
  {
    step: "Run inside an authorized boundary",
    detail:
      "Self-host the Docker images in a cloud region that already holds a FedRAMP High authorization, such as AWS GovCloud (US) or Azure Government, under your agency's ATO.",
    status: "available",
  },
  {
    step: "Inherit infrastructure controls",
    detail:
      "Hosting, network and physical controls come from the provider's package. Your security team documents the application layer: RBAC, the append-only audit log, and the AI fallback set to off or to a local model.",
    status: "available",
  },
  {
    step: "Validate an isolated deployment",
    detail: "Offline operation with local OCR and storage works by design but hasn't been tested inside an enclave.",
    status: "configuration",
  },
  {
    step: "Dataomatix's own FedRAMP authorization",
    detail: "Not started, and no timeline is committed. Until it exists, use the inherited path above.",
    status: "not-yet",
  },
];

export default function TrustDeploymentSection() {
  return (
    <section id="trust" className="scroll-mt-24">
      <div className="mb-8 max-w-2xl">
        <p className="section-eyebrow">Trust &amp; deployment</p>
        <h2 className="section-title">Where it runs, and what we can claim today.</h2>
        <p className="section-lede">
          Federal teams ask about deployment before they ask about accuracy, so
          each answer carries its status: available now, or not there yet.
        </p>
      </div>

      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {ITEMS.map((item) => (
          <li key={item.title} className="pillar-card">
            <div className="flex items-start justify-between gap-3">
              <item.icon className="h-5 w-5 text-primary" strokeWidth={1.75} />
              <span
                className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_COPY[item.status].tone}`}
              >
                {STATUS_COPY[item.status].label}
              </span>
            </div>
            <h3 className="pillar-title">{item.title}</h3>
            <p className="pillar-body">{item.body}</p>
          </li>
        ))}
      </ul>

      <div className="mt-6 editorial-card p-5">
        <h3 className="font-medium text-foreground">Path to a federal authorization</h3>
        <p className="mt-1 text-sm text-text-secondary">
          What a federal buyer can do today, and what isn&apos;t done yet.
        </p>
        <ol className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {AUTHORIZATION_PATH.map((item, index) => (
            <li key={item.step} className="rounded-lg border border-border p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold tabular-nums text-text-muted">
                  0{index + 1}
                </span>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_COPY[item.status].tone}`}
                >
                  {STATUS_COPY[item.status].label}
                </span>
              </div>
              <p className="mt-2 text-sm font-medium text-foreground">{item.step}</p>
              <p className="mt-1 text-xs leading-5 text-text-secondary">{item.detail}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
