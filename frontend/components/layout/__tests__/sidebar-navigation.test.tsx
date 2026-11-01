import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/documents",
}));

const statusCounts = vi.fn();
vi.mock("@/lib/documents", () => ({
  getDocumentStatusCounts: () => statusCounts(),
}));

import SidebarNavigation from "@/components/layout/SidebarNavigation";

describe("SidebarNavigation", () => {
  beforeEach(() => {
    window.localStorage.clear();
    statusCounts.mockReset();
    statusCounts.mockResolvedValue({ total: 0, by_status: {} });
  });

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

  it("shows the item's name as a tooltip on hover or focus when collapsed", () => {
    render(
      <SidebarNavigation collapsed mobileOpen={false} onCollapsedChange={() => {}} onMobileClose={() => {}} />,
    );
    const link = screen.getByTestId("nav-obligations");
    fireEvent.mouseEnter(link);
    expect(screen.getByText("Obligations", { selector: ".workspace-sidebar-tooltip" })).toBeInTheDocument();
    fireEvent.mouseLeave(link);
    expect(document.querySelector(".workspace-sidebar-tooltip")).toBeNull();
    fireEvent.focus(screen.getByTestId("nav-documents"));
    expect(screen.getByText("Documents", { selector: ".workspace-sidebar-tooltip" })).toBeInTheDocument();
  });

  it("draws group dividers instead of group labels when collapsed, and no tooltip when expanded", () => {
    const { rerender } = render(
      <SidebarNavigation collapsed mobileOpen={false} onCollapsedChange={() => {}} onMobileClose={() => {}} />,
    );
    expect(document.querySelectorAll(".workspace-sidebar-divider").length).toBeGreaterThan(0);
    expect(document.querySelector(".workspace-sidebar-group")).toBeNull();
    rerender(
      <SidebarNavigation collapsed={false} mobileOpen={false} onCollapsedChange={() => {}} onMobileClose={() => {}} />,
    );
    fireEvent.mouseEnter(screen.getByTestId("nav-obligations"));
    expect(document.querySelector(".workspace-sidebar-tooltip")).toBeNull();
    expect(document.querySelector(".workspace-sidebar-group")).not.toBeNull();
  });

  it("shows how many documents wait for review and how many are processing", async () => {
    statusCounts.mockResolvedValue({ total: 10, by_status: { review_required: 4, processing: 2 } });
    render(
      <SidebarNavigation collapsed={false} mobileOpen={false} onCollapsedChange={() => {}} onMobileClose={() => {}} />,
    );
    expect(await screen.findByTestId("nav-badge-review")).toHaveTextContent("4");
    expect(screen.getByTestId("nav-badge-extraction")).toHaveAccessibleName(/2 documents are processing/i);
  });

  it("shows no badge when nothing is waiting or the counts fail to load", async () => {
    statusCounts.mockRejectedValue(new Error("offline"));
    render(
      <SidebarNavigation collapsed={false} mobileOpen={false} onCollapsedChange={() => {}} onMobileClose={() => {}} />,
    );
    await Promise.resolve();
    expect(screen.queryByTestId("nav-badge-review")).toBeNull();
  });

  it("folds a group, keeps the current page visible, and remembers the choice", () => {
    const { unmount } = render(
      <SidebarNavigation collapsed={false} mobileOpen={false} onCollapsedChange={() => {}} onMobileClose={() => {}} />,
    );
    const group = screen.getByRole("button", { name: /document processing/i });
    expect(group).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(group);
    expect(group).toHaveAttribute("aria-expanded", "false");
    // /documents is the current page, so it survives the fold; its siblings don't.
    expect(screen.getByTestId("nav-documents")).toBeInTheDocument();
    expect(screen.queryByTestId("nav-extraction")).toBeNull();
    unmount();

    render(
      <SidebarNavigation collapsed={false} mobileOpen={false} onCollapsedChange={() => {}} onMobileClose={() => {}} />,
    );
    expect(screen.getByRole("button", { name: /document processing/i })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: /document processing/i }));
    expect(screen.getByTestId("nav-extraction")).toBeInTheDocument();
  });

  it("moves focus between entries with the arrow keys", () => {
    render(
      <SidebarNavigation collapsed={false} mobileOpen={false} onCollapsedChange={() => {}} onMobileClose={() => {}} />,
    );
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const documents = screen.getByTestId("nav-documents");
    documents.focus();
    fireEvent.keyDown(documents, { key: "ArrowDown" });
    expect(screen.getByTestId("nav-extraction")).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(within(nav).getByTestId("nav-settings")).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(within(nav).getByRole("button", { name: /workspace/i })).toHaveFocus();
  });
});
