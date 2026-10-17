/**
 * Per-block transcript render cache.
 *
 * ## The problem this exists for
 *
 * `TUIApp.paintTranscript` runs on every streaming tick, and it used to call
 * `renderTranscript`, which re-parses EVERY block's markdown each time —
 * O(total transcript content) per frame, growing with session length. Every
 * comparable TUI avoids this: codex writes settled history into the
 * terminal's own scrollback (settled lines are never re-rendered at all),
 * claude-code memoizes markdown by content hash. This is the blessed-shell
 * equivalent of the latter.
 *
 * ## Key design
 *
 * One cache entry per block id. The key is the block's kind-specific content
 * FNV-1a-hashed, plus every render-option facet that can change this block's
 * output: group-continuation flag, expansion state, tool-result visibility,
 * the result-line cap, and the theme. Hashing (not re-rendering) is the
 * cheap part — roughly two orders of magnitude — so correctness does not
 * depend on any mutation site remembering to bump a revision counter.
 *
 * The selection prefix (`❯ `) is deliberately NOT cached: it is applied at
 * flatten time, so moving the history selection re-renders nothing.
 *
 * ## The line-count invariant
 *
 * `renderTranscript` joins blocks with `'\n'` and no separator rows, so the
 * flattened line count is exactly `Σ blockHeights` (the join's newline
 * terminates the previous block's last line; it does not open a new one).
 * `heights()` and `totalLines()` exist so scroll math can run off that sum
 * without building the flattened string, and `revealSelectedBlock` depends on
 * them agreeing with `paintTranscript`'s window to the line.
 */

import type { Block, TranscriptModel } from './blocks.js';
import {
  blockExpanded,
  renderBlock,
  renderToolContinuation,
  stylesOf,
  type RenderOptions,
} from './transcript-view.js';
import { toolGroupKey } from './tool-render.js';

/** FNV-1a, 32-bit. Not cryptographic — it guards against accidental drift, not adversaries. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** The content that, plus the option facets, fully determines a block's rendering. */
function blockContent(block: Block): string {
  switch (block.kind) {
    case 'user': return `u:${block.text}`;
    case 'assistant': return `a:${block.finalized ? 1 : 0}:${block.text}`;
    // The duration is part of the key: the head text changes from `Thinking…`
    // to `Thought for 1.2s` the moment the block seals, and the seal mutates
    // the duration without touching the text.
    case 'thinking': return `t:${block.finalized ? 1 : 0}:${block.durationMs ?? ''}:${block.text}`;
    case 'tool': return `k:${block.status}:${block.name}:${block.preview}:${block.command ?? ''}:${block.result ?? ''}`;
    case 'error': return `e:${block.message}`;
    case 'notice': return `n:${block.text}`;
  }
}

interface CacheEntry {
  key: string;
  lines: string[];
}

export class TranscriptRenderer {
  private readonly cache = new Map<string, CacheEntry>();

  /** Cache telemetry — assertions and honest measurement, not decoration. */
  readonly stats = { hits: 0, misses: 0 };

  /** Drop every entry. The next frame re-renders from scratch. */
  invalidate(): void {
    this.cache.clear();
    this.stats.hits = 0;
    this.stats.misses = 0;
  }

  /**
   * Per-block rendered line arrays, cache-fed. Lines carry NO selection
   * prefix — `lines()` adds that, keeping cache entries selection-independent.
   */
  blocks(model: TranscriptModel, options: RenderOptions): string[][] {
    const styles = stylesOf(options);
    const themeKey = options.theme === undefined ? 'dark' : fnv1a(JSON.stringify(options.theme));
    const result: string[][] = [];
    const seen = new Set<string>();
    // Only a tool block directly after a tool block of the SAME FAMILY joins a
    // group; any other block resets it. Mirrors `renderTranscript` exactly.
    let pendingGroupKey: string | null = null;
    let pendingGroupName: string | null = null;

    for (const block of model.blocks) {
      const groupKey = block.kind === 'tool' ? toolGroupKey(block.name) : null;
      const continuation = block.kind === 'tool' && groupKey !== null && pendingGroupKey === groupKey;
      // The continuation flag distinguishes the SAME-name ('c') and
      // CROSS-name ('f') heads: they render different text from identical
      // block content, so they cannot share a cache entry.
      const sameName = continuation && pendingGroupName === block.name;
      const key = [
        block.kind,
        continuation ? (sameName ? 'c' : 'f') : '-',
        blockExpanded(block.id, options) ? 'e' : '-',
        options.showToolResults ? 'r' : '-',
        String(options.toolResultLines),
        themeKey,
        fnv1a(blockContent(block)),
      ].join('|');

      seen.add(block.id);
      const hit = this.cache.get(block.id);
      let lines: string[];
      if (hit !== undefined && hit.key === key) {
        lines = hit.lines;
        this.stats.hits += 1;
      } else {
        const rendered = continuation
          ? renderToolContinuation(block, options, styles, pendingGroupName ?? undefined)
          : renderBlock(block, options, styles);
        lines = rendered.split('\n');
        this.cache.set(block.id, { key, lines });
        this.stats.misses += 1;
      }
      result.push(lines);
      pendingGroupKey = groupKey;
      pendingGroupName = block.kind === 'tool' ? block.name : null;
    }

    this.prune(seen);
    return result;
  }

  /** Per-block line counts, cache-fed. `Σ heights` is the flattened line count. */
  heights(model: TranscriptModel, options: RenderOptions): number[] {
    return this.blocks(model, options).map((lines) => lines.length);
  }

  /** The whole transcript's line count without building it. */
  totalLines(model: TranscriptModel, options: RenderOptions): number {
    return this.heights(model, options).reduce((total, lines) => total + lines, 0);
  }

  /**
   * All transcript lines, flattened, with the history-selection prefix
   * applied. Byte-identical to `renderTranscript(...).split('\n')` — the
   * cache tests pin that equality.
   */
  lines(model: TranscriptModel, options: RenderOptions): string[] {
    const blocks = this.blocks(model, options);
    const styles = stylesOf(options);
    const lines: string[] = [];
    for (const [index, block] of model.blocks.entries()) {
      const blockLines = blocks[index];
      if (blockLines === undefined) continue;
      if (block.id === options.selectedBlockId) {
        const [first, ...rest] = blockLines;
        if (first !== undefined) lines.push(`${styles.accent('❯')} ${first}`, ...rest);
      } else {
        lines.push(...blockLines);
      }
    }
    return lines;
  }

  /**
   * Evict entries for blocks that no longer exist (`/clear`, session swap).
   * Runs only when the map has grown well past the live set, so steady-state
   * frames do not pay for it.
   */
  private prune(seen: ReadonlySet<string>): void {
    if (this.cache.size <= seen.size + 32) return;
    for (const id of this.cache.keys()) {
      if (!seen.has(id)) this.cache.delete(id);
    }
  }
}
