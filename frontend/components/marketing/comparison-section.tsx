import { Check, Minus } from "lucide-react";

const ROWS: { capability: string; generic: string; dataomatix: string }[] = [
  {
    capability: "Where a value came from",
    generic: "Text output, sometimes with a page number",
    dataomatix: "Boxed on the source page, with page, region and method",
  },
  {
    capability: "When it isn't sure",
    generic: "Returns its best guess",
    dataomatix: "Sends the field to a reviewer with the reason",
  },
  {
    capability: "Repeating records (CLINs, funding, clauses)",
    generic: "Flattened into prose or one long table",
    dataomatix: "One record per row, with the source's own column headings",
  },
  {
    capability: "Corrections",
    generic: "Lost when you re-run the prompt",
    dataomatix: "Append-only audit trail; exports use the reviewed value",
  },
  {
    capability: "FAR / DFARS coverage",
    generic: "Whatever the model happens to recall",
    dataomatix: "Clause references matched to the FAR and checked against your playbook",
  },
  {
    capability: "Downstream systems",
    generic: "Copy and paste",
    dataomatix: "Staging workbook, CSV/Excel and an Oracle payload preview behind RBAC",
  },
];

export default function ComparisonSection() {
  return (
    <section id="compare-approaches" className="scroll-mt-24">
      <div className="mb-8 max-w-2xl">
        <p className="section-eyebrow">Why not a generic assistant</p>
        <h2 className="section-title">Same document, different standard of proof.</h2>
        <p className="section-lede">
          A general OCR tool or chat assistant can read a contract. Dataomatix
          is built so that every value can be checked before it&apos;s used.
        </p>
      </div>

      <div className="editorial-card overflow-x-auto">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wider text-text-muted">
              <th className="px-5 py-3 font-medium">Question</th>
              <th className="px-5 py-3 font-medium">Generic OCR / chat assistant</th>
              <th className="px-5 py-3 font-medium text-primary">Dataomatix</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.capability} className="border-b border-border last:border-0 align-top">
                <th scope="row" className="px-5 py-4 font-medium text-foreground">
                  {row.capability}
                </th>
                <td className="px-5 py-4 text-text-secondary">
                  <span className="flex gap-2">
                    <Minus className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
                    {row.generic}
                  </span>
                </td>
                <td className="px-5 py-4 text-foreground">
                  <span className="flex gap-2">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                    {row.dataomatix}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
