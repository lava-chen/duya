import { create } from "zustand";
import type { SettingsTab, ViewType } from "./conversation-store";

/**
 * Title-bar back/forward history over app-level navigation.
 *
 * A history entry is a snapshot of the navigation surfaces:
 *   - `view` + `threadId` — the main-area view and selected session
 *   - `settingsTab` — which settings pane was open (settings view only)
 *   - `panel` — the side-panel page surface (open + active page tab), which
 *     is how canvas/browser/preview/review/workflow-node pages navigate
 *
 * AppShell commits every transition through `commit()` and registers an
 * applier (`registerNavApplier`) that back()/forward() invoke to restore the
 * target snapshot. Two timing guards keep the stacks clean:
 *
 *   - Commits are coalesced for COMMIT_COALESCE_MS. One user action can fire
 *     the commit effect twice (e.g. a thread switch first renders with the
 *     previous session's panel state, then the sessionKey effect swaps in the
 *     new session's persisted layout) — coalescing collapses them into the
 *     settled state.
 *   - After back()/forward() applies a snapshot, APPLY_SUPPRESS_MS swallows
 *     the echo commits the apply itself provokes (including the session-layout
 *     swap). Without this, an echo that drifted (e.g. agent browser tabs are
 *     filtered out of panel persistence) would push a phantom entry and wipe
 *     the forward stack.
 */

export interface NavHistoryEntry {
  view: ViewType;
  threadId: string | null;
  settingsTab: SettingsTab | null;
  panel: { open: boolean; activeTabId: string | null };
}

const MAX_HISTORY = 50;
const COMMIT_COALESCE_MS = 30;
const APPLY_SUPPRESS_MS = 150;

let applier: ((entry: NavHistoryEntry) => void) | null = null;

/**
 * AppShell registers the function that restores a snapshot onto the live
 * stores (conversation store + panel context). The panel state lives in
 * React context, so the applier must be a component-scoped callback rather
 * than a module-level store action.
 */
export function registerNavApplier(fn: ((entry: NavHistoryEntry) => void) | null): void {
  applier = fn;
}

const sameEntry = (a: NavHistoryEntry | null, b: NavHistoryEntry): boolean =>
  a !== null &&
  a.view === b.view &&
  a.threadId === b.threadId &&
  (a.settingsTab ?? null) === (b.settingsTab ?? null) &&
  a.panel.open === b.panel.open &&
  a.panel.activeTabId === b.panel.activeTabId;

interface NavHistoryState {
  past: NavHistoryEntry[];
  present: NavHistoryEntry | null;
  future: NavHistoryEntry[];
  commit: (entry: NavHistoryEntry) => void;
  back: () => void;
  forward: () => void;
  /** Push any coalescing commit immediately (also used by tests). */
  flushPending: () => void;
}

let pendingEntry: NavHistoryEntry | null = null;
let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
let suppressUntil = 0;

/** Test hook: clear the module-level timing state between tests. */
export function resetNavHistoryForTests(): void {
  if (coalesceTimer !== null) {
    clearTimeout(coalesceTimer);
    coalesceTimer = null;
  }
  pendingEntry = null;
  suppressUntil = 0;
  useNavHistoryStore.setState({ past: [], present: null, future: [] });
}

export const useNavHistoryStore = create<NavHistoryState>((set, get) => ({
  past: [],
  present: null,
  future: [],
  commit: (entry) => {
    pendingEntry = entry;
    if (coalesceTimer === null) {
      coalesceTimer = setTimeout(() => {
        coalesceTimer = null;
        get().flushPending();
      }, COMMIT_COALESCE_MS);
    }
  },
  flushPending: () => {
    if (coalesceTimer !== null) {
      clearTimeout(coalesceTimer);
      coalesceTimer = null;
    }
    const entry = pendingEntry;
    pendingEntry = null;
    if (!entry || Date.now() < suppressUntil) return;
    const { present, past } = get();
    if (sameEntry(present, entry)) return;
    set({
      present: entry,
      past: present ? [...past, present].slice(-MAX_HISTORY) : past,
      // A fresh navigation invalidates the forward stack (standard history).
      future: [],
    });
  },
  back: () => {
    get().flushPending();
    const { past, present, future } = get();
    if (past.length === 0) return;
    const target = past[past.length - 1];
    set({
      past: past.slice(0, -1),
      present: target,
      future: present ? [present, ...future] : future,
    });
    suppressUntil = Date.now() + APPLY_SUPPRESS_MS;
    applier?.(target);
  },
  forward: () => {
    get().flushPending();
    const { past, present, future } = get();
    if (future.length === 0) return;
    const target = future[0];
    set({
      past: present ? [...past, present].slice(-MAX_HISTORY) : past,
      present: target,
      future: future.slice(1),
    });
    suppressUntil = Date.now() + APPLY_SUPPRESS_MS;
    applier?.(target);
  },
}));
