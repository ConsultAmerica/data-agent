import { SkeletonDocumentWorkspace } from "@/components/ui/skeleton";

/** A single document — without this, the list skeleton above would show. */
export default function DocumentLoading() {
  return <SkeletonDocumentWorkspace />;
}
