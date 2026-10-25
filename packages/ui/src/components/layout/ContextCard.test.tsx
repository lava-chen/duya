// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useContextUsageStore, type LiveContextUsage } from "@/stores/context-usage-store";
import { ContextCard } from "./ContextCard";

const sessionId = "sess-1";

function seed(live: Partial<LiveContextUsage> | null) {
  useContextUsageStore.setState((state) => ({
    liveBySession: {
      ...state.liveBySession,
      [sessionId]: live
        ? ({
            usedTokens: 0,
            anchored: true,
            inputTokens: 0,
            outputTokens: 0,
            updatedAt: Date.now(),
            ...live,
          } as LiveContextUsage)
        : undefined,
    },
  }));
}

afterEach(() => {
  cleanup();
  useContextUsageStore.setState({ liveBySession: {}, compositionBySession: {} });
});

describe("ContextCard", () => {
  it("renders nothing without a resolvable window", () => {
    seed({ usedTokens: 4000, anchored: true });
    const { container } = render(<ContextCard sessionId={sessionId} />);
    expect(container.querySelector('[data-testid="rail-context-card"]')).toBeNull();
  });

  it("renders the percent headline, bar and legend from the composition", () => {
    seed({
      usedTokens: 463_600,
      contextWindow: 1_000_000,
      anchored: true,
      composition: {
        unattributedObservedTokens: 0,
        system: [{ label: "prompt", tokens: 10_300 }],
        conversation: [{ label: "msgs", tokens: 408_300 }],
        injectedContext: [],
        skills: [{ label: "skill:x", tokens: 5_900 }],
        toolDefinitions: [{ label: "tools", tokens: 37_100 }],
        toolResults: [],
        attachments: [],
        memory: [{ label: "memory", tokens: 1_900 }],
        providerOverhead: [],
      },
    });
    render(<ContextCard sessionId={sessionId} />);
    expect(screen.getByTestId("rail-context-card")).toBeTruthy();
    expect(screen.getByText("46% used")).toBeTruthy();
    expect(document.querySelector(".ctx-window")?.textContent).toBe("463.6k / 1M");
    const legendRows = document.querySelectorAll(".ctx-legend-row");
    // Zero-token buckets are dropped; 5 of the 6 seeded buckets carry tokens.
    expect(legendRows.length).toBe(5);
    // The free-space segment closes the bar to 100% (5 legend + 1 free).
    expect(document.querySelectorAll(".ctx-bar-seg").length).toBe(6);
  });

  it("hides zero-token buckets from the legend", () => {
    seed({
      usedTokens: 10_000,
      contextWindow: 200_000,
      anchored: true,
      composition: {
        unattributedObservedTokens: 0,
        system: [],
        conversation: [{ label: "msgs", tokens: 10_000 }],
        injectedContext: [],
        skills: [],
        toolDefinitions: [],
        toolResults: [],
        attachments: [],
        memory: [],
        providerOverhead: [],
      },
    });
    render(<ContextCard sessionId={sessionId} />);
    const rows = document.querySelectorAll(".ctx-legend-row");
    expect(rows).toHaveLength(1);
  });
});
