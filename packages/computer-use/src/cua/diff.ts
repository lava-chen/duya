/**
 * cua/diff.ts — snapshot diffing and mode decision.
 *
 * Port of the ZCode/Codex snapshot diff (plan 575): elements are keyed
 * by window title + role + title, material field changes are value /
 * label / focused / enabled / editable / bounds / actions, and the
 * observation mode is full / delta / no_change. The delta-node ratio
 * (0.4) and the 50-entry change caps are verbatim.
 */

import type { CuaElement, CuaSnapshotDiff } from './types.js';

/** Changed/total above this → the delta would be bigger than the full tree. */
const DELTA_NODE_RATIO = 0.4;

/** Per-diff caps — the model-visible change list is bounded. */
const MAX_CHANGES_PER_BUCKET = 50;

export function stableNodeId(el: CuaElement, windowTitle: string): string {
  const role = (el.role || '').trim().toLowerCase();
  const title = (el.title || '').trim().toLowerCase();
  const win = (windowTitle || '').trim().toLowerCase();
  return `${win}\0${role}\0${title}`;
}

function sameBounds(
  a: [number, number, number, number] | null,
  b: [number, number, number, number] | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function materialFieldDiff(
  oldEl: CuaElement,
  newEl: CuaElement,
): CuaSnapshotDiff['updated'][number]['changes'] {
  const changes: CuaSnapshotDiff['updated'][number]['changes'] = {};
  if ((oldEl.value || '') !== (newEl.value || '')) changes.value = newEl.value ?? '';
  const oldLabel = oldEl.title ?? '';
  const newLabel = newEl.title ?? '';
  if (oldLabel !== newLabel) changes.label = newEl.title;
  if ((oldEl.focused ?? false) !== (newEl.focused ?? false)) changes.focused = newEl.focused;
  if ((oldEl.enabled ?? true) !== (newEl.enabled ?? true)) changes.enabled = newEl.enabled;
  if ((oldEl.editable ?? false) !== (newEl.editable ?? false)) changes.editable = newEl.editable;
  if (!sameBounds(oldEl.bounds, newEl.bounds)) changes.bounds = newEl.bounds;
  const oldA = (oldEl.actions || []).join(',');
  const newA = (newEl.actions || []).join(',');
  if (oldA !== newA) changes.actions = newEl.actions ?? [];
  return changes;
}

function findFocusedTitle(
  elements: CuaElement[],
): string | null {
  const focused = elements.find((e) => e.focused);
  return focused?.title ?? focused?.value ?? null;
}

/**
 * Diff two element tables (same window). `oldElements === null` means
 * the first observation: everything is "added" so the model still gets
 * a bounded change summary.
 */
export function diffSnapshots(
  oldElements: CuaElement[] | null,
  oldWindowTitle: string,
  newElements: CuaElement[],
  newWindowTitle: string,
): CuaSnapshotDiff {
  if (!oldElements) {
    return {
      added: newElements.map((e, i) => ({ index: i, role: e.role, title: e.title })),
      updated: [],
      removed: [],
      addedCount: newElements.length,
      updatedCount: 0,
      removedCount: 0,
      focusChanged: false,
      focusedTitle: findFocusedTitle(newElements),
    };
  }

  const groupByStableId = (elements: CuaElement[], winTitle: string) => {
    const map = new Map<string, Array<{ el: CuaElement; index: number }>>();
    elements.forEach((el, index) => {
      const sid = stableNodeId(el, winTitle);
      const list = map.get(sid);
      if (list) list.push({ el, index });
      else map.set(sid, [{ el, index }]);
    });
    return map;
  };

  const oldMap = groupByStableId(oldElements, oldWindowTitle);
  const newMap = groupByStableId(newElements, newWindowTitle);

  const added: CuaSnapshotDiff['added'] = [];
  const updated: CuaSnapshotDiff['updated'] = [];
  const removed: CuaSnapshotDiff['removed'] = [];

  for (const [sid, newList] of newMap.entries()) {
    const oldList = oldMap.get(sid) ?? [];
    if (oldList.length === 0) {
      for (const { el, index } of newList) {
        added.push({ index, role: el.role, title: el.title });
      }
    } else if (oldList.length === newList.length) {
      for (let i = 0; i < newList.length; i += 1) {
        const oldEntry = oldList[i];
        const newEntry = newList[i];
        if (!oldEntry || !newEntry) continue;
        const changes = materialFieldDiff(oldEntry.el, newEntry.el);
        if (Object.keys(changes).length > 0) {
          updated.push({
            index: newEntry.index,
            role: newEntry.el.role,
            title: newEntry.el.title,
            changes,
          });
        }
      }
    } else if (newList.length > oldList.length) {
      for (let i = oldList.length; i < newList.length; i += 1) {
        const entry = newList[i];
        if (!entry) continue;
        added.push({ index: entry.index, role: entry.el.role, title: entry.el.title });
      }
    } else {
      for (let i = newList.length; i < oldList.length; i += 1) {
        const entry = oldList[i];
        if (!entry) continue;
        removed.push({ role: entry.el.role, title: entry.el.title });
      }
    }
  }
  for (const [sid, oldList] of oldMap.entries()) {
    if (!newMap.has(sid)) {
      for (const { el } of oldList) {
        removed.push({ role: el.role, title: el.title });
      }
    }
  }

  const oldFocused = findFocusedTitle(oldElements);
  const newFocused = findFocusedTitle(newElements);
  return {
    added: added.slice(0, MAX_CHANGES_PER_BUCKET),
    updated: updated.slice(0, MAX_CHANGES_PER_BUCKET),
    removed: removed.slice(0, MAX_CHANGES_PER_BUCKET),
    addedCount: added.length,
    updatedCount: updated.length,
    removedCount: removed.length,
    focusChanged: oldFocused !== newFocused,
    focusedTitle: newFocused,
  };
}

function sameBoundsArray(
  previous: [number, number, number, number] | null | undefined,
  next: [number, number, number, number] | null | undefined,
): boolean {
  if (previous === undefined && next === undefined) return true;
  if (!previous || !next) return previous === next;
  return previous.every((value, index) => value === next[index]);
}

/** Decide the observation mode for the next emission. */
export function decideSnapshotMode(
  diff: CuaSnapshotDiff,
  opts: {
    previousWindowTitle: string;
    newWindowTitle: string;
    previousWindowId: number;
    newWindowId: number;
    previousWindowBounds?: [number, number, number, number] | null;
    newWindowBounds?: [number, number, number, number] | null;
    totalElements: number;
  },
): 'full' | 'delta' | 'no_change' {
  if (opts.previousWindowTitle !== opts.newWindowTitle) return 'full';
  if (opts.previousWindowId !== opts.newWindowId) return 'full';
  if (!sameBoundsArray(opts.previousWindowBounds ?? null, opts.newWindowBounds ?? null)) {
    return 'full';
  }
  const changed = diff.addedCount + diff.removedCount + diff.updatedCount;
  if (changed === 0 && !diff.focusChanged) return 'no_change';
  if (opts.totalElements > 0 && changed / opts.totalElements > DELTA_NODE_RATIO) return 'full';
  return 'delta';
}

/**
 * Snapshot cache keyed by pid+window (aligned with the ZCode helper:
 * diff baselines are per pid+window, not per session).
 */
export class CuaSnapshotCache {
  private cache = new Map<number, Map<string, { elements: CuaElement[]; stateId: string; title: string; bounds: [number, number, number, number] | null }>>();

  private windowKey(windowId: number, bounds: [number, number, number, number] | null, title: string | null): string {
    if (Number.isSafeInteger(windowId) && windowId > 0) return `window-id:${windowId}`;
    return `bounds:${(bounds ?? [0, 0, 0, 0]).join(',')}|title:${title ?? ''}`;
  }

  get(pid: number, windowId: number, bounds: [number, number, number, number] | null, title: string | null) {
    return this.cache.get(pid)?.get(this.windowKey(windowId, bounds, title));
  }

  set(
    pid: number,
    windowId: number,
    bounds: [number, number, number, number] | null,
    title: string | null,
    entry: { elements: CuaElement[]; stateId: string },
  ) {
    let windows = this.cache.get(pid);
    if (!windows) {
      windows = new Map();
      this.cache.set(pid, windows);
    }
    windows.set(this.windowKey(windowId, bounds, title), {
      elements: entry.elements,
      stateId: entry.stateId,
      title: title ?? '',
      bounds,
    });
  }

  invalidate(pid: number): void {
    this.cache.delete(pid);
  }

  clear(): void {
    this.cache.clear();
  }
}
