import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/documents/doc-9/review",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/layout/document-chrome-context", () => ({
  useDocumentChrome: () => ({
    documentTitle: "SF1442.pdf",
    setDocumentTitle: () => undefined,
  }),
}));

import Breadcrumbs from "@/components/layout/Breadcrumbs";

describe("Breadcrumbs", () => {
  it("reflects document workspace context and marks the current page", () => {
    render(<Breadcrumbs />);
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(nav).toHaveTextContent("Documents");
    expect(nav).toHaveTextContent("SF1442.pdf");
    expect(nav).toHaveTextContent("Review");
    expect(screen.getByText("Review")).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "SF1442.pdf" })).toHaveAttribute(
      "href",
      "/documents/doc-9",
    );
  });
});
