import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pathname = vi.fn(() => "/");

vi.mock("next/navigation", () => ({
  usePathname: () => pathname(),
  useSearchParams: () => new URLSearchParams(),
  // The marketing shell's Ask widget navigates with the router.
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("@/lib/documents", () => ({
  getDocumentStatusCounts: () => Promise.resolve({ total: 0, by_status: {} }),
}));

vi.mock("@/components/global-search", () => ({
  default: () => null,
  useGlobalSearchShortcut: () => undefined,
}));


import AppShell from "@/components/layout/AppShell";

describe("AppShell", () => {
  beforeEach(() => {
    pathname.mockReturnValue("/");
  });

  it("uses the marketing shell on the homepage", () => {
    render(
      <AppShell>
        <p>Home body</p>
      </AppShell>,
    );
    expect(screen.getByTestId("marketing-shell")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-shell")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workspace-sidebar")).not.toBeInTheDocument();
  });

  it("uses the workspace shell with sidebar on application routes", () => {
    pathname.mockReturnValue("/documents");
    render(
      <AppShell>
        <p>Docs body</p>
      </AppShell>,
    );
    expect(screen.getByTestId("workspace-shell")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-topbar")).toBeInTheDocument();
    expect(screen.getByTestId("breadcrumbs")).toBeInTheDocument();
    expect(screen.queryByTestId("marketing-shell")).not.toBeInTheDocument();
  });

  function setDesktop(matches: boolean) {
    window.matchMedia = vi.fn().mockReturnValue({ matches }) as unknown as typeof window.matchMedia;
  }

  it("menu button collapses the sidebar on desktop", () => {
    pathname.mockReturnValue("/documents");
    setDesktop(true);
    render(
      <AppShell>
        <p>Docs body</p>
      </AppShell>,
    );
    const sidebar = screen.getByTestId("workspace-sidebar");
    expect(sidebar).toHaveAttribute("data-collapsed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Toggle navigation" }));
    expect(sidebar).toHaveAttribute("data-collapsed", "true");
    expect(sidebar).toHaveAttribute("data-mobile-open", "false");
  });

  it("menu button opens the drawer with full labels below desktop width", () => {
    pathname.mockReturnValue("/documents");
    setDesktop(true);
    render(
      <AppShell>
        <p>Docs body</p>
      </AppShell>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Toggle navigation" })); // collapse on desktop
    setDesktop(false);
    fireEvent.click(screen.getByRole("button", { name: "Toggle navigation" }));
    const sidebar = screen.getByTestId("workspace-sidebar");
    expect(sidebar).toHaveAttribute("data-mobile-open", "true");
    // The drawer ignores the collapsed rail.
    expect(sidebar).toHaveAttribute("data-collapsed", "false");
  });
});
