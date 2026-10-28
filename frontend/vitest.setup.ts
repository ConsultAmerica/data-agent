import "@testing-library/jest-dom/vitest";

// jsdom does not implement matchMedia; illustrations and motion guards need it.
if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

// Components read the backend review gate from /ready (lib/review-gate.ts).
// Answer it locally — open — so no test reaches a real backend; tests that
// stub fetch themselves still replace this.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  String(input instanceof Request ? input.url : input).endsWith("/ready")
    ? Promise.resolve(
        new Response(JSON.stringify({ metadata_review_mutations_enabled: true }), {
          headers: { "Content-Type": "application/json" },
        }),
      )
    : realFetch(input, init)) as typeof fetch;
