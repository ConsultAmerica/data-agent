import ConfidenceMeter from "@/components/ui/confidence-meter";

interface ConfidenceIndicatorProps {
  confidence: number;
  showPercent?: boolean;
}

/** Kept for existing call sites; renders the policy-banded ConfidenceMeter
 * (green ≥ 85%, amber ≥ 60%, red below) instead of a bare colored dot. */
export default function ConfidenceIndicator({
  confidence,
  showPercent = true,
}: ConfidenceIndicatorProps) {
  return <ConfidenceMeter value={confidence} showLabel={showPercent} />;
}
