/**
 * workflow-def-watcher.ts — push-based refresh for the dwf library list.
 *
 * `SavedWorkflowStore.list()` is a live readdirSync, but the library view only
 * fetches on mount, so files created outside the app (agent conversations,
 * manual edits) never showed up until a manual refresh. This module watches
 * the directories the list handler already returns (the store's contract:
 * "扫过的目录……GUI 的文件监听靠它 watch") and pushes `workflow:dwf:changed`
 * to every live renderer that has listed workflows at least once.
 *
 * Lifecycle: watchers exist only while at least one sender is registered;
 * the last sender going away closes them all. Errors on a watched dir (e.g.
 * the project root disappearing) degrade to closing that one watcher — the
 * next `workflow:dwf:list` call re-ensures it.
 */

import * as fs from 'node:fs';

/** Structural subset of Electron WebContents — keeps this unit-testable. */
export interface WatcherSender {
  isDestroyed(): boolean;
  send(channel: string, payload?: unknown): void;
  once(event: string, listener: () => void): unknown;
}

export interface DefWatcherDeps {
  /** Start watching a directory; returns an unsubscribe function. */
  watchDir(dir: string, onChange: () => void): () => void;
  /** Debounce window coalescing bursts of fs events (per manager, not per dir). */
  debounceMs?: number;
}

export interface DefWatcherManager {
  /** Idempotently watch every dir; safe to call on every list request. */
  ensureWatchers(dirs: string[]): void;
  /** Register a renderer; duplicates are ignored. */
  addSender(sender: WatcherSender): void;
  /** Close everything — for tests and shutdown. */
  dispose(): void;
}

export function createDefWatcherManager(deps: DefWatcherDeps): DefWatcherManager {
  const debounceMs = deps.debounceMs ?? 400;
  const watched = new Map<string, () => void>();
  const senders = new Set<WatcherSender>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const notify = (): void => {
    if (timer) return; // already scheduled
    timer = setTimeout(() => {
      timer = null;
      for (const sender of senders) {
        if (sender.isDestroyed()) {
          senders.delete(sender);
          continue;
        }
        try {
          sender.send('workflow:dwf:changed', {});
        } catch {
          senders.delete(sender);
        }
      }
    }, debounceMs);
  };

  const closeWatcher = (dir: string): void => {
    const un = watched.get(dir);
    if (un) {
      watched.delete(dir);
      try {
        un();
      } catch {
        // already gone
      }
    }
  };

  const manager: DefWatcherManager = {
    ensureWatchers(dirs) {
      for (const dir of dirs) {
        if (watched.has(dir)) continue;
        try {
          const un = deps.watchDir(dir, notify);
          watched.set(dir, un);
        } catch {
          // Directory may not exist yet (store returns it regardless). The
          // next list call re-ensures; nothing to do now.
        }
      }
    },

    addSender(sender) {
      if (senders.has(sender)) return;
      senders.add(sender);
      sender.once('destroyed', () => {
        senders.delete(sender);
        if (senders.size === 0) manager.dispose();
      });
    },

    dispose() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      for (const dir of [...watched.keys()]) closeWatcher(dir);
      senders.clear();
    },
  };

  return manager;
}

/**
 * Default fs.watch binding. Watches only the directory's direct entries —
 * `.dwf.ts` files always live flat in the root, which is all we need.
 * A watcher that errors (dir deleted, EMFILE, …) is closed; re-ensured on
 * the next list call.
 */
export function defaultWatchDir(dir: string, onChange: () => void): () => void {
  const watcher = fs.watch(dir, { persistent: false }, () => onChange());
  watcher.on('error', () => {
    try {
      watcher.close();
    } catch {
      // ignore
    }
  });
  return () => watcher.close();
}
