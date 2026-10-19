/**
 * Memoised measure — the minimal form of "prune a subtree whose height did not
 * change".
 *
 * ## Why the signature walks the children
 *
 * The obvious key is `(id, revision, width)`. It is wrong for containers: a
 * VStack's own revision does not change when a CHILD updates, so the stack would
 * report a stale height forever. The key is therefore the whole subtree's
 * `(id, revision)` pairs plus the width, which costs a walk over the tree — a
 * handful of nodes — and in exchange the expensive part (`measure` on a
 * 10k-block transcript) runs only when something under it actually changed.
 *
 * Phase 4 asks for exactly that: heights are reused, and the cost that gets
 * skipped is the leaf's, not the container's.
 *
 * ## What it does not do
 *
 * It does not decide WHICH subtree is dirty; there is no event for that. The
 * cache is consulted, the signature says whether the cached height is still the
 * answer, and a miss recomputes. That is enough to make "render an unchanged
 * tree twice" cost zero measures, which is the property the tests pin.
 */

import type { UIComponent } from './component.js';

interface Entry {
  readonly signature: string;
  readonly height: number;
}

export class MeasureCache {
  private readonly entries = new Map<string, Entry>();
  /** Telemetry, like `transcript-cache`'s: assertions read these. */
  readonly stats = { hits: 0, misses: 0 };

  /** The height of `component` at `width`, recomputing only on a stale key. */
  measure(component: UIComponent, width: number): number {
    const signature = this.signatureOf(component, width);
    const cached = this.entries.get(component.id);
    if (cached !== undefined && cached.signature === signature) {
      this.stats.hits += 1;
      return cached.height;
    }
    this.stats.misses += 1;
    const height = component.measure(width);
    this.entries.set(component.id, { signature, height });
    return height;
  }

  /** Drop one component's entry, or every entry. */
  invalidate(id?: string): void {
    if (id === undefined) this.entries.clear();
    else this.entries.delete(id);
  }

  /** `id@revision(width)` for the node and everything under it. */
  private signatureOf(component: UIComponent, width: number): string {
    const own = `${component.id}@${component.revision}(${Math.floor(width)})`;
    const children = component.children;
    if (children === undefined || children.length === 0) return own;
    return `${own}[${children.map((child) => this.signatureOf(child, width)).join(',')}]`;
  }
}

/** Reset the counters, for a test that wants to measure one operation. */
export function resetMeasureStats(cache: MeasureCache): void {
  cache.stats.hits = 0;
  cache.stats.misses = 0;
}
