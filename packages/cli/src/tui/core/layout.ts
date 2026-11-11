/**
 * Layout slots with pi's `layout.ts` semantics: basis, grow, shrink, clamps.
 *
 * ## Why a second distributor next to `distribute()`
 *
 * `distribute()` (containers.ts) answers the question the five-region
 * fullscreen layout has needed so far: fixed slots plus flex shares. The
 * render-unification plan (P0) replaces that geometry with a tree, and a tree
 * needs the vocabulary every dock/pane layout eventually grows into — a
 * preferred size (basis) that can GROW into leftover space and SHRINK under
 * deficit, bounded by min/max. Expressing that as flags on `distribute()`
 * would wed the existing callers to it; a pure function beside it lets P0
 * migrate region by region with the old path untouched.
 *
 * ## The algorithm, and the invariant that pins it
 *
 * Basis first; then the deficit (total − Σ basis) is settled: negative by
 * shrinking (weighted by `shrink`, never below `min`), positive by growing
 * (weighted by `grow`, never past `max`). The INVARIANT the tests pin: the
 * sizes sum EXACTLY to `total` whenever `total ≥ Σ min` — rounding is
 * allocated to the first eligible slot, never dropped, because a dropped cell
 * is the visibly missing last row of the screen (the same rule
 * `distribute()` already follows).
 *
 * Pure: no component knowledge, no mutation — P0's caller owns the tree.
 */

/** One slot of a layout row/column, with grow/shrink constraints. */
export interface LayoutSlot {
  /**
   * The preferred size. `'flex'` is basis 0 with grow 1 — the transcript
   * pane's "take the leftover" shape, spelled the way callers say it today.
   */
  readonly basis: 'flex' | number;
  /** Share of leftover space (deficit > 0). Defaults to 1 for `'flex'`, 0 for a number. */
  readonly grow?: number;
  /** Share of the deficit (deficit < 0). Defaults to 1; 0 means "never shrink me". */
  readonly shrink?: number;
  /** Never smaller than this (a composer's minimum readable body). */
  readonly min?: number;
  /** Never larger than this (a sidebar's preferred width cap). */
  readonly max?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Split `total` among the slots. Sums to exactly `total` when `total ≥ Σ min`;
 * when it does not, the mins win and the sum is `Σ min` (an over-constrained
 * layout overflows by construction — the caller's bug to see in tests).
 */
export function distributeLayout(slots: readonly LayoutSlot[], total: number): number[] {
  if (slots.length === 0) return [];

  const minOf = (slot: LayoutSlot): number => Math.max(0, Math.floor(slot.min ?? 0));
  const maxOf = (slot: LayoutSlot): number => slot.max === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(slot.max));
  const growOf = (slot: LayoutSlot): number => Math.max(0, slot.grow ?? (slot.basis === 'flex' ? 1 : 0));
  const shrinkOf = (slot: LayoutSlot): number => Math.max(0, slot.shrink ?? 1);

  // Basis pass, clamped to the walls — INCLUDING a flex slot's min: a slot
  // whose minimum exceeds the leftover cannot start below it, or the final
  // clamp would break the exact-sum invariant (a flex transcript with min 3
  // in a 6-row layout must open at 3, not at 0 waiting for a grow pass).
  const sizes = slots.map((slot) => clamp(slot.basis === 'flex' ? 0 : Math.floor(slot.basis), minOf(slot), maxOf(slot)));
  let deficit = total - sizes.reduce((sum, size) => sum + size, 0);

  // Settlement: take/give the deficit weighted by factor, with every slot
  // clamped at its wall. A single weighted pass cannot honor the walls AND
  // the exact sum (a slot frozen at its min hands its share to the others),
  // so this iterates: each pass either zeroes the deficit or freezes at
  // least one slot against a wall, which bounds it by the slot count.
  for (let pass = 0; pass <= slots.length + 1 && deficit !== 0; pass += 1) {
    const shrinking = deficit < 0;
    const factorOf = shrinking ? shrinkOf : growOf;
    const candidates: number[] = [];
    let weight = 0;
    for (const [index, slot] of slots.entries()) {
      const factor = factorOf(slot);
      const room = shrinking ? (sizes[index] ?? 0) - minOf(slot) : maxOf(slot) - (sizes[index] ?? 0);
      if (factor > 0 && room > 0) {
        candidates.push(index);
        weight += factor;
      }
    }
    if (candidates.length === 0 || weight === 0) break;

    const magnitude = Math.abs(deficit);
    let moved = 0;
    // Every candidate has room by construction, so the first one is the
    // remainder's home even when its own weighted share floors to zero — a
    // 1-row deficit over growers weighted 1:2 floors both shares to 0, and
    // dropping it would break the exact-sum invariant.
    const first = candidates[0] ?? -1;
    const deltas = new Map<number, number>();
    for (const index of candidates) {
      const factor = factorOf(slots[index]!);
      const room = shrinking ? (sizes[index] ?? 0) - minOf(slots[index]!) : maxOf(slots[index]!) - (sizes[index] ?? 0);
      const wanted = Math.floor(factor * magnitude / weight);
      const delta = Math.min(wanted, room);
      if (delta > 0) {
        deltas.set(index, delta);
        moved += delta;
      }
    }
    // Rounding is allocated, not dropped: the first eligible slot absorbs
    // what the floors left, capped by its own room.
    if (first !== -1 && moved < magnitude) {
      const room = shrinking
        ? (sizes[first] ?? 0) - minOf(slots[first]!) - (deltas.get(first) ?? 0)
        : maxOf(slots[first]!) - (sizes[first] ?? 0) - (deltas.get(first) ?? 0);
      const extra = Math.min(room, magnitude - moved);
      if (extra > 0) {
        deltas.set(first, (deltas.get(first) ?? 0) + extra);
        moved += extra;
      }
    }
    const step = shrinking ? -1 : 1;
    for (const [index, delta] of deltas) {
      sizes[index] = (sizes[index] ?? 0) + step * delta;
    }
    deficit = total - sizes.reduce((sum, size) => sum + size, 0);
  }

  // An over-constrained row (total < Σ min) settles on the mins; the overflow
  // is visible in the sum, which is the caller's bug to see in a test.
  for (const [index, slot] of slots.entries()) {
    sizes[index] = Math.max(minOf(slot), sizes[index] ?? 0);
  }
  return sizes;
}
