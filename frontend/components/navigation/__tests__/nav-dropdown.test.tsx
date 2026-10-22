import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import NavDropdown from "@/components/navigation/NavDropdown";
import { topMenu } from "@/components/navigation/nav-config";

vi.mock("next/navigation", () => ({ usePathname: () => "/documents" }));

function renderMenus() {
  return render(
    <div>
      <NavDropdown label="Platform" href="/platform" sections={topMenu("platform").sections} />
      <NavDropdown label="Review" href="/review" sections={topMenu("review").sections} />
      <p>Outside</p>
    </div>,
  );
}

describe("NavDropdown", () => {
  it("opens a compact two-column Platform popover with Workspace and Intelligence", () => {
    renderMenus();
    const button = screen.getByRole("button", { name: "Platform" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button.querySelector("svg")).toHaveClass("rotate-180");

    const menu = screen.getByRole("menu", { name: "Platform menu" });
    expect(within(menu).getByText("Workspace")).toBeInTheDocument();
    expect(within(menu).getByText("Intelligence")).toBeInTheDocument();
    const items = within(menu).getAllByRole("menuitem").map((item) => item.textContent);
    expect(items.some((text) => text?.startsWith("Documents"))).toBe(true);
    expect(items.some((text) => text?.startsWith("FAR / DFARS"))).toBe(true);
    // Relationships lives under Intelligence, not Platform.
    expect(items.some((text) => text?.includes("Relationships"))).toBe(false);
  });

  it("closes on Escape (focus back on its button) and on an outside click", () => {
    renderMenus();
    const button = screen.getByRole("button", { name: "Platform" });
    fireEvent.click(button);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(button).toHaveFocus();

    fireEvent.click(button);
    fireEvent.mouseDown(screen.getByText("Outside"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("switching menus never updates one menu while another is rendering", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      renderMenus();
      fireEvent.click(screen.getByRole("button", { name: "Platform" }));
      fireEvent.click(screen.getByRole("button", { name: "Review" }));
      fireEvent.click(screen.getByRole("button", { name: "Platform" }));
      expect(screen.getAllByRole("menu")).toHaveLength(1);
      const renderPhaseUpdates = errors.mock.calls.filter((args) =>
        String(args[0]).includes("Cannot update a component"),
      );
      expect(renderPhaseUpdates).toHaveLength(0);
    } finally {
      errors.mockRestore();
    }
  });

  it("keeps only one menu open and closes after choosing an item", () => {
    renderMenus();
    fireEvent.click(screen.getByRole("button", { name: "Platform" }));
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByRole("menu", { name: "Review menu" })).toBeInTheDocument();

    fireEvent.click(within(screen.getByRole("menu")).getAllByRole("menuitem")[0]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("fills only the one section that owns the page", async () => {
    const { menuForPath } = await import("@/components/navigation/nav-config");
    // /documents is linked from Documents and Platform; Documents owns it.
    expect(menuForPath("/documents")).toBe("documents");
    expect(menuForPath("/platform")).toBe("platform");
    expect(menuForPath("/ask")).toBe("platform");
    expect(menuForPath("/relationships")).toBe("intelligence");
    expect(menuForPath("/")).toBeNull();
    render(<NavDropdown label="Review" href="/review" sections={topMenu("review").sections} current />);
    const pill = screen.getByRole("button", { name: "Review" });
    expect(pill).toHaveAttribute("data-current", "true");
    expect(pill).toHaveClass("rounded-full", "bg-white"); // the filled pill
  });
});
