import { SkeletonPage } from "@/components/ui/skeleton";

/** Route loading: a page-shaped placeholder instead of a spinner, so the
 * layout doesn't jump when the page arrives. */
export default function GlobalLoading() {
  return <SkeletonPage label="Loading workspace…" />;
}
