/**
 * Plan 624 F2 — composition consistency across a compaction boundary.
 *
 * A codex-style `has_retained_fragment` check would be a false green here:
 * the rail is never written to the timeline (`context-rail.ts:20-22`) and
 * `run-engine.ts:2986-2994` re-attaches `origin:'context'` rows from the
 * CURRENT projection, so "is the fragment still in retained history" is
 * trivially true by construction.
 *
 * These are the two checks that can actually fail:
 *
 *   1. The compaction entry's `reinjectedSystemMessages` must appear in the
 *      system prompt the next request sends. Before B2 the host discarded the
 *      whole structured projection, so this failed on every compaction.
 *   2. The diff baseline (`lastRailContents`, F1's clock state) belongs to a
 *      conversation window. A new compaction entry makes it stale; the rail
 *      must be re-established from first-contact framing.
 *
 * Both degrade by doing the work again rather than by trusting stale state.
 */
import { createHash } from 'node:crypto';

import type { ContextBlock } from '../worker-context/context-rail.js';
import { flattenSystemProjection } from '../worker-context/system-projection.js';

export interface CompositionSnapshot {
  /** Compaction epoch of the timeline this composition was built from. */
  readonly windowId: string;
  readonly blockIds: readonly string[];
  /** Hash of every block's id, source and content. */
  readonly fingerprint: string;
}

export type CompositionConsistencyReason =
  | 'first-turn'
  | 'unchanged'
  | 'content-changed'
  | 'window-changed'
  | 'blocks-missing';

export interface CompositionConsistency {
  /** True when the rail baseline must be discarded and every block re-sent. */
  readonly restore: boolean;
  readonly reason: CompositionConsistencyReason;
  readonly missingBlockIds: readonly string[];
  readonly snapshot: CompositionSnapshot;
}

export function buildCompositionSnapshot(
  windowId: string,
  blocks: readonly ContextBlock[],
): CompositionSnapshot {
  const sorted = [...blocks].sort((a, b) => a.id.localeCompare(b.id));
  const hash = createHash('sha256');
  for (const block of sorted) {
    hash.update(`${block.id}\0${block.source}\0${block.content}\0`, 'utf8');
  }
  return {
    windowId,
    blockIds: sorted.map((block) => block.id),
    fingerprint: hash.digest('hex').slice(0, 16),
  };
}

export function checkCompositionConsistency(
  previous: CompositionSnapshot | undefined,
  current: CompositionSnapshot,
  deliveredBlockIds: readonly string[],
): CompositionConsistency {
  if (!previous) {
    return { restore: false, reason: 'first-turn', missingBlockIds: [], snapshot: current };
  }
  if (previous.windowId !== current.windowId) {
    return { restore: true, reason: 'window-changed', missingBlockIds: [], snapshot: current };
  }
  const delivered = new Set(deliveredBlockIds);
  const missingBlockIds = current.blockIds.filter((id) => !delivered.has(id));
  if (missingBlockIds.length > 0) {
    return { restore: true, reason: 'blocks-missing', missingBlockIds, snapshot: current };
  }
  if (previous.fingerprint !== current.fingerprint) {
    // D2 already frames content changes; no need to discard the baseline.
    return { restore: false, reason: 'content-changed', missingBlockIds: [], snapshot: current };
  }
  return { restore: false, reason: 'unchanged', missingBlockIds: [], snapshot: current };
}

/**
 * Texts a compaction entry promises to reinject, flattened the same way the
 * system projection flattens them.
 */
export function extractReinjectedTexts(
  reinjected: readonly (string | readonly unknown[])[] | undefined,
): string[] {
  if (!reinjected) return [];
  const texts: string[] = [];
  for (const entry of reinjected) {
    const text = flattenSystemProjection(entry).text;
    if (text.length > 0) texts.push(text);
  }
  return texts;
}

/** Which promised texts are absent from the system prompt about to be sent. */
export function checkReinjectedSystemContent(
  reinjected: readonly (string | readonly unknown[])[] | undefined,
  renderedSystem: string,
): { readonly checked: number; readonly missing: readonly string[] } {
  const texts = extractReinjectedTexts(reinjected);
  return {
    checked: texts.length,
    missing: texts.filter((text) => !renderedSystem.includes(text)),
  };
}
