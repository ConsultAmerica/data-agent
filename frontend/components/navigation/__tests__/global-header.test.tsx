import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/obligations", useRouter: () => ({ push: vi.fn() }) }));
const { probeBackend } = vi.hoisted(() => ({
  probeBackend: vi.fn(() => Promise.resolve({ state: "healthy", retryable: false, message: null as string | null })),
}));
vi.mock("@/lib/api", () => ({ probeBackend }));
vi.mock("@/lib/auth", () => ({
  getCurrentActor: () => Promise.resolve({ display_name: "Doris Castro", role: "reviewer", email: "d@x.mil" }),
}));

import GlobalHeader from "@/components/navigation/GlobalHeader";
import { deployEnvironment } from "@/components/navigation/client-env";

describe("GlobalHeader", () => {
  it("shows the five sections as pills with no 'More' overflow", () => {
    render(<GlobalHeader onOpenSearch={() => {}} />);
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    const pills = Array.from(nav.querySelectorAll("button")).map((button) => button.textContent);
    expect(pills).toEqual(["Documents", "Platform", "Intelligence", "Review", "Governance"]);
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
  });

  it("offers the command palette with its shortcut and the profile, with no status badge while the API is healthy", async () => {
    const onOpenSearch = vi.fn();
    render(<GlobalHeader onOpenSearch={onOpenSearch} />);
    const triggers = screen.getAllByRole("button", { name: /Search or jump to/ });
    triggers[0].click();
    expect(onOpenSearch).toHaveBeenCalled();
    await waitFor(() => expect(screen.getAllByTestId("user-chip")[0]).toHaveTextContent("DC"));
    expect(screen.getAllByTestId("user-chip")[0]).toHaveTextContent("Reviewer");
    expect(screen.queryByTestId("backend-status")).toBeNull();
    expect(screen.queryByText(/API Ready/)).toBeNull();
  });

  it("never shows a backend status or environment badge, even while the backend wakes up", async () => {
    probeBackend.mockResolvedValue({ state: "unreachable", retryable: true, message: "Starting" });
    render(<GlobalHeader onOpenSearch={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId("user-chip")[0]).toBeInTheDocument());
    expect(screen.queryByTestId("backend-status")).toBeNull();
    expect(screen.queryByText(/waking up|Local ·/)).toBeNull();
  });
});

describe("deployEnvironment", () => {
  it("uses the configured name, otherwise infers from the host and never invents GovCloud", () => {
    expect(deployEnvironment("app.example.com", "GovCloud-US-East")).toBe("GovCloud-US-East");
    expect(deployEnvironment("localhost", "")).toBe("Local");
    expect(deployEnvironment("dataomatix-git-main.vercel.app", "")).toBe("Preview");
    expect(deployEnvironment("app.dataomatix.com", "")).toBe("Production");
  });
});
