import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pathname = vi.fn(() => "/");

vi.mock("next/navigation", () => ({
  usePathname: () => pathname(),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/global-search", () => ({
  default: () => null,
  useGlobalSearchShortcut: () => undefined,
}));

vi.mock("@/components/navigation/BackendStatusPill", () => ({
  default: () => <span>status</span>,
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
});
