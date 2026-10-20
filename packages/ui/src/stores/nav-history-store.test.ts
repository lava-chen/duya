import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The applier writes back onto the conversation store. Mock it so the test
// never pulls the real store's DB-backed module graph.
const conversation = vi.hoisted(() => ({
  currentView: "home",
  activeThreadId: null as string | null,
  settingsTab: "general",
  setActiveThread: vi.fn((id: string) => {
    conversation.activeThreadId = id;
  }),
  setCurrentView: vi.fn((view: string) => {
    conversation.currentView = view;
  }),
}));

vi.mock("./conversation-store", () => ({
  useConversationStore: {
    getState: () => conversation,
    setState: (partial: Record<string, unknown>) => {
      Object.assign(conversation, partial);
    },
  },
}));

import {
  registerNavApplier,
  resetNavHistoryForTests,
  useNavHistoryStore,
  type NavHistoryEntry,
} from "./nav-history-store";

const entry = (overrides: Partial<NavHistoryEntry> = {}): NavHistoryEntry => ({
  view: "chat",
  threadId: "t1",
  settingsTab: null,
  panel: { open: false, activeTabId: null },
  ...overrides,
});

describe("nav-history-store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    conversation.currentView = "home";
    conversation.activeThreadId = null;
    conversation.settingsTab = "general";
    registerNavApplier(null);
    // Clears the module-level coalesce/suppress state that would otherwise
    // leak across tests.
    resetNavHistoryForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("commits (coalesced) navigations and clears the forward stack", () => {
    const nav = useNavHistoryStore.getState();
    nav.commit(entry({ threadId: "t1" }));
    nav.flushPending();
    nav.commit(entry({ view: "settings", threadId: null }));
    nav.flushPending();
    expect(useNavHistoryStore.getState().present).toEqual(
      entry({ view: "settings", threadId: null }),
    );

    useNavHistoryStore.getState().back();
    // Real users take longer than the suppress window to navigate again.
    vi.advanceTimersByTime(200);
    useNavHistoryStore.getState().commit(entry({ view: "workflow", threadId: null }));
    useNavHistoryStore.getState().flushPending();
    const state = useNavHistoryStore.getState();
    expect(state.future).toEqual([]);
    expect(state.past.map((e) => e.view)).toEqual(["chat"]);
  });

  it("coalesces rapid commits into one entry", () => {
    useNavHistoryStore.getState().commit(entry({ threadId: "t1" }));
    // A thread switch fires the commit effect twice (panel layout swap) —
    // only the settled snapshot may land.
    useNavHistoryStore.getState().commit(entry({ threadId: "t1", panel: { open: true, activeTabId: "p" } }));
    vi.advanceTimersByTime(50);
    const state = useNavHistoryStore.getState();
    expect(state.past).toEqual([]);
    expect(state.present?.panel).toEqual({ open: true, activeTabId: "p" });
  });

  it("ignores echo commits of the current entry", () => {
    useNavHistoryStore.getState().commit(entry());
    useNavHistoryStore.getState().flushPending();
    // Re-committing the exact same snapshot (e.g. the effect re-firing after
    // a back()/forward() apply) must not push history.
    useNavHistoryStore.getState().commit(entry());
    useNavHistoryStore.getState().flushPending();
    expect(useNavHistoryStore.getState().past).toEqual([]);
  });

  it("commits panel-page navigation within the same session", () => {
    useNavHistoryStore.getState().commit(entry({ panel: { open: false, activeTabId: null } }));
    useNavHistoryStore.getState().flushPending();
    useNavHistoryStore.getState().commit(entry({ panel: { open: true, activeTabId: "page-1" } }));
    useNavHistoryStore.getState().flushPending();
    const state = useNavHistoryStore.getState();
    expect(state.past).toHaveLength(1);
    expect(state.present?.panel).toEqual({ open: true, activeTabId: "page-1" });
  });

  it("back/forward apply through the registered applier", () => {
    const applied: NavHistoryEntry[] = [];
    registerNavApplier((target) => applied.push(target));

    useNavHistoryStore.getState().commit(entry({ threadId: "t1" }));
    useNavHistoryStore.getState().flushPending();
    useNavHistoryStore.getState().commit(entry({ view: "settings", threadId: null, settingsTab: "providers" }));
    useNavHistoryStore.getState().flushPending();

    useNavHistoryStore.getState().back();
    expect(applied).toHaveLength(1);
    expect(applied[0]).toEqual(entry({ threadId: "t1" }));

    useNavHistoryStore.getState().forward();
    expect(applied).toHaveLength(2);
    expect(applied[1].settingsTab).toBe("providers");
    expect(useNavHistoryStore.getState().future).toEqual([]);
  });

  it("suppresses echo commits right after an apply (forward stack survives)", () => {
    registerNavApplier(() => {});
    useNavHistoryStore.getState().commit(entry({ threadId: "t1" }));
    useNavHistoryStore.getState().flushPending();
    useNavHistoryStore.getState().commit(entry({ view: "home", threadId: null }));
    useNavHistoryStore.getState().flushPending();

    useNavHistoryStore.getState().back();
    // The apply provokes an echo commit that drifted (e.g. session layout
    // swap) — it must be dropped, not pushed, or forward would be wiped.
    useNavHistoryStore.getState().commit(entry({ view: "home", threadId: null, panel: { open: true, activeTabId: "x" } }));
    useNavHistoryStore.getState().flushPending();
    expect(useNavHistoryStore.getState().future).toHaveLength(1);

    // After the suppress window, normal commits land again.
    vi.advanceTimersByTime(200);
    useNavHistoryStore.getState().commit(entry({ view: "workflow", threadId: null }));
    useNavHistoryStore.getState().flushPending();
    expect(useNavHistoryStore.getState().present?.view).toBe("workflow");
    expect(useNavHistoryStore.getState().future).toEqual([]);
  });

  it("back/forward are no-ops on empty stacks", () => {
    const applied = vi.fn();
    registerNavApplier(applied);
    useNavHistoryStore.getState().back();
    useNavHistoryStore.getState().forward();
    expect(applied).not.toHaveBeenCalled();
  });
});
