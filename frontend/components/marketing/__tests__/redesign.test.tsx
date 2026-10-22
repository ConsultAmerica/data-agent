import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import AgentRunMockup from "@/components/marketing/agent-run-mockup";
import AssistantWidget from "@/components/marketing/assistant-widget";
import FeatureStack from "@/components/marketing/feature-stack";
import NextStepBand from "@/components/marketing/next-step-band";

describe("AssistantWidget", () => {
  beforeEach(() => {
    push.mockReset();
    window.localStorage.clear();
  });

  it("opens from the pill and sends a typed question to /ask", async () => {
    render(<AssistantWidget />);
    fireEvent.click(await screen.findByRole("button", { name: "DataoAI" }));
    fireEvent.change(screen.getByLabelText("Ask DataoAI a question"), { target: { value: "Who is the contractor?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(push).toHaveBeenCalledWith("/ask?q=Who%20is%20the%20contractor%3F");
  });

  it("runs a quick question", async () => {
    render(<AssistantWidget />);
    fireEvent.click(await screen.findByRole("button", { name: "DataoAI" }));
    fireEvent.click(screen.getByRole("button", { name: /DFARS 252\.204-7012/ }));
    expect(push).toHaveBeenCalledWith(`/ask?q=${encodeURIComponent("Which contracts include DFARS 252.204-7012?")}`);
  });

  it("stays dismissed once closed", async () => {
    const { unmount } = render(<AssistantWidget />);
    fireEvent.click(await screen.findByRole("button", { name: "DataoAI" }));
    fireEvent.click(screen.getByRole("button", { name: "Close assistant" }));
    expect(screen.queryByRole("button", { name: "DataoAI" })).toBeNull();
    unmount();
    render(<AssistantWidget />);
    await Promise.resolve();
    expect(screen.queryByRole("button", { name: "DataoAI" })).toBeNull();
  });
});

describe("AgentRunMockup", () => {
  it("advances the run with the hero stage", () => {
    const { container, rerender } = render(<AgentRunMockup stage={0} />);
    expect(container.querySelectorAll(".agent-step.is-done")).toHaveLength(4);
    expect(container.textContent).toContain("2 candidates");
    rerender(<AgentRunMockup stage={2} />);
    expect(container.querySelectorAll(".agent-step.is-done")).toHaveLength(7);
    expect(container.textContent).toContain("Run complete");
    expect(container.textContent).toContain("Sample Contracting Activity");
  });
});

describe("FeatureStack and NextStepBand", () => {
  it("links each feature to its workspace page", () => {
    render(<FeatureStack />);
    for (const href of ["/sample", "/ask", "/obligations", "/playbook", "/compare", "/actions"]) {
      expect(document.querySelector(`a[href="${href}"]`)).toBeTruthy();
    }
  });

  it("offers the sample and an extraction as next steps", () => {
    render(<NextStepBand />);
    expect(screen.getByRole("heading", { name: /Ready for your next step/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open the sample contract/ }).getAttribute("href")).toBe("/sample");
    expect(screen.getByRole("link", { name: /Start an extraction/ }).getAttribute("href")).toBe("/extraction/new");
  });
});
