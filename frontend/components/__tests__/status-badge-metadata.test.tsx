import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import StatusBadge from "@/components/status-badge";

describe("StatusBadge metadata vocabulary", () => {
  it("labels metadata statuses distinctly from Staging Verified", () => {
    const { rerender } = render(<StatusBadge kind="field" status="pending" />);
    expect(screen.getByText("Metadata Pending")).toBeTruthy();

    rerender(<StatusBadge kind="field" status="accepted" verified />);
    expect(screen.getByText("Metadata Accepted")).toBeTruthy();
    expect(screen.queryByText(/^Verified$/)).toBeNull();
    expect(screen.queryByText("Staging Verified")).toBeNull();

    rerender(<StatusBadge kind="field" status="edited" />);
    expect(screen.getByText("Metadata Edited")).toBeTruthy();

    rerender(<StatusBadge kind="field" status="rejected" />);
    expect(screen.getByText("Metadata Rejected")).toBeTruthy();
  });
});
