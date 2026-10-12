import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/documents",
}));

import SidebarNavigation from "@/components/layout/SidebarNavigation";

describe("SidebarNavigation", () => {
  it("marks the active destination for assistive tech", () => {
    render(
      <SidebarNavigation
        collapsed={false}
        mobileOpen={false}
        onCollapsedChange={() => undefined}
        onMobileClose={() => undefined}
      />,
    );
    expect(screen.getByTestId("nav-documents")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("nav-extraction")).not.toHaveAttribute("aria-current");
  });

  it("exposes a collapse control with aria-expanded", () => {
    const onCollapsedChange = vi.fn();
    render(
      <SidebarNavigation
        collapsed={false}
        mobileOpen={false}
        onCollapsedChange={onCollapsedChange}
        onMobileClose={() => undefined}
      />,
    );
    const toggle = screen.getByRole("button", { name: /collapse sidebar/i });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(onCollapsedChange).toHaveBeenCalledWith(true);
  });

  it("keeps labels available to screen readers when collapsed", () => {
    render(
      <SidebarNavigation
        collapsed
        mobileOpen={false}
        onCollapsedChange={() => undefined}
        onMobileClose={() => undefined}
      />,
    );
    expect(screen.getByTestId("workspace-sidebar")).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByTestId("nav-documents")).toHaveAccessibleName(/documents/i);
  });

  it("closes the mobile drawer when a link is activated", () => {
    const onMobileClose = vi.fn();
    render(
      <SidebarNavigation
        collapsed={false}
        mobileOpen
        onCollapsedChange={() => undefined}
        onMobileClose={onMobileClose}
      />,
    );
    fireEvent.click(screen.getByTestId("nav-review"));
    expect(onMobileClose).toHaveBeenCalled();
  });
});
