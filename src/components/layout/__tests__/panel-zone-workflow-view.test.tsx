// @vitest-environment jsdom
// Regression: clicking a run card on the workflow management page dispatches
// `duya:open-workflow-run-panel`, which opens the side panel — but PanelZone's
// non-session force-close effect killed it immediately (the panel flashed and
// vanished). The workflow view is now exempt; every other non-session view
// keeps the force-close.
import { act, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PanelProvider } from "@/hooks/usePanel";
import { useConversationStore } from "@/stores/conversation-store";
import { PanelZone } from "../PanelZone";
import { setTaskDrawerOpen } from "../task-drawer-store";

// The lazy workflow tab resolves through the real module graph (WorkflowPanel
// → WorkflowRunCard → icon packages that do not import under vitest). The
// component itself is not under test here — only the open/close lifecycle.
vi.mock("../panels/WorkflowPanel", () => ({
  WorkflowPanel: () => null,
  RunsTab: () => null,
}));

const PANEL_STORAGE_KEY = "duya:panel:v2:__home__";

function Harness(): ReactNode {
  return createElement(PanelZone);
}

function renderZone() {
  return render(createElement(PanelProvider, null, createElement(Harness)));
}

function dispatchOpenRunPanel(runId: string) {
  window.dispatchEvent(
    new CustomEvent("duya:open-workflow-run-panel", { detail: { runId } })
  );
}

describe("PanelZone force-close vs workflow view", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setTaskDrawerOpen(false);
    window.localStorage.setItem(
      PANEL_STORAGE_KEY,
      JSON.stringify({
        tabs: [],
        activeTabId: null,
        panelOpen: false,
        panelView: "picker",
        workspaceExpanded: false,
        workspaceTreeOpen: false,
      })
    );
  });

  it("keeps the panel open on the workflow management view (run card click)", async () => {
    useConversationStore.setState({ currentView: "workflow", activeThreadId: null });
    renderZone();

    act(() => dispatchOpenRunPanel("run-1"));

    await waitFor(() => {
      expect(document.querySelector(".panel-zone-open")).not.toBeNull();
    });
    // Give the force-close effect a chance to run against the open panel —
    // it must not close it on this view.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.querySelector(".panel-zone-open")).not.toBeNull();
  });

  it("still force-closes the panel on non-session, non-workflow views", async () => {
    useConversationStore.setState({ currentView: "home", activeThreadId: null });
    renderZone();

    act(() => dispatchOpenRunPanel("run-1"));

    await waitFor(() => {
      expect(document.querySelector(".panel-zone-closed")).not.toBeNull();
    });
  });
});
