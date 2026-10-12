import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import WorkflowBreadcrumb from "@/components/workflow-breadcrumb";

describe("WorkflowBreadcrumb", () => {
  it("renders the RC2-03 product steps and marks the active step", () => {
    render(<WorkflowBreadcrumb activeStep="discover_schema" />);
    const nav = screen.getByRole("navigation", { name: "Extraction workflow" });
    expect(nav.textContent).toMatch(/Upload/);
    expect(nav.textContent).toMatch(/Understand/);
    expect(nav.textContent).toMatch(/Discover Schema/);
    expect(nav.textContent).toMatch(/Extract/);
    expect(nav.textContent).toMatch(/Validate/);
    expect(nav.textContent).toMatch(/Prepare Staging/);
    expect(screen.getByText("Discover Schema").getAttribute("aria-current")).toBe("step");
  });
});
