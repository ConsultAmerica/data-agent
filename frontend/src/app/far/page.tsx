import { redirect } from "next/navigation";

/** /far is a short alias for the FAR / DFARS intelligence page. */
export default async function FarPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const q = (await searchParams).q;
  const query = Array.isArray(q) ? q[0] : q;
  redirect(query ? `/clauses?q=${encodeURIComponent(query)}` : "/clauses");
}
