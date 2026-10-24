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
 * output: its TRAIL SLOT (the plan — connector, batch header, rail, whether a
 * separator row precedes it), expansion state, tool-result visibility, the
 * result-line cap, and the theme. Hashing (not re-rendering) is the cheap part
 * — roughly two orders of magnitude — so correctness does not depend on any
 * mutation site remembering to bump a revision counter.
 *
 * The trail slot is in the key because the plan depends on NEIGHBOURS: the
 * last execution unit of a turn draws `└` and the moment another tool arrives
 * it must become `├`, with its children's rail flipping from spaces to `│`.
 * A key that ignored neighbours would leave those rows stale.
 *
 * The selection prefix (`❯ `) is deliberately NOT cached: it is applied at
 * flatten time, so moving the history selection re-renders nothing.
 *
 * ## The line-count invariant
 *
 * `renderTranscript` joins blocks with `'\n'` and no standalone separator
 * rows: a stanza gap is the FIRST line of the block below it, so the flattened
 * line count stays exactly `Σ blockHeights` (the join's newline terminates the
 * previous block's last line; it does not open a new one). `heights()` and
 * `totalLines()` exist so scroll math can run off that sum without building
 * the flattened string, and `revealSelectedBlock` depends on them agreeing
 * with `paintTranscript`'s window to the line.
 */

import type { Block, TranscriptModel } from './blocks.js';
import { todoKey } from './todo.js';
import {
  blockExpanded,
  planKey,
  planTranscript,
  renderPlannedBlock,
  stylesOf,
  visibleBlocks,
  type RenderOptions,
} from './transcript-view.js';

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
    // The todo list is part of the key: it is read out of the RESULT, so a
    // list whose items changed status would otherwise keep rendering the
    // version the reader first saw.
    case 'tool': return `k:${block.status}:${block.name}:${block.preview}:${block.command ?? ''}:${block.result ?? ''}:${todoKey(block.todos)}`;
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
    // The trail depends on NEIGHBOURS — a connector flips `├` → `└` when a
    // later block arrives, and a batch header counts its run — so the plan is
    // part of every key. `planTranscript` is the same function the uncached
    // renderer uses, which is what keeps the two paths byte-identical.
    const blocks = visibleBlocks(model.blocks, options);
    const plans = planTranscript(blocks);

    blocks.forEach((block, index) => {
      const plan = plans[index];
      if (plan === undefined) return;
      const key = [
        block.kind,
        planKey(plan),
        blockExpanded(block.id, options) ? 'e' : '-',
        options.showToolResults ? 'r' : '-',
        String(options.toolResultLines),
        String(options.width ?? 0),
        // plan 615 Phase 0: the renderer decides whether emphasis/strike
        // render as italic/strike attributes or fold — a facet of the bytes.
        options.renderer ?? 'blessed',
        themeKey,
        // plan 615 §5.4: a component can change a block's height without
        // changing its content, so its revision has to be part of the key or
        // the cached lines would report the old height for new layout.
        String(options.componentRevisions?.get(block.id) ?? 0),
        fnv1a(blockContent(block)),
      ].join('|');

      seen.add(block.id);
      const hit = this.cache.get(block.id);
      let lines: string[];
      if (hit !== undefined && hit.key === key) {
        lines = hit.lines;
        this.stats.hits += 1;
      } else {
        lines = renderPlannedBlock(block, plan, options, styles);
        this.cache.set(block.id, { key, lines });
        this.stats.misses += 1;
      }
      result.push(lines);
    });

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
    for (const [index, block] of visibleBlocks(model.blocks, options).entries()) {
      const blockLines = blocks[index];
      if (blockLines === undefined) continue;
      if (block.id === options.selectedBlockId) {
        // Same rule as `renderTranscript`: the caret rides the first non-empty
        // row, because a stanza gap belongs to this block and comes first.
        const target = blockLines.findIndex((line) => line !== '');
        const at = target === -1 ? 0 : target;
        const caret = `${styles.accent('❯')} ${blockLines[at]}`;
        lines.push(...blockLines.slice(0, at), caret, ...blockLines.slice(at + 1));
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

/**
 * Everything about a render that changes the BYTES, as one comparable string.
 *
 * The document-level cache is only sound if its key covers every input the
 * renderer reads. This is that list, and it is separate from the per-block key
 * on purpose: expanding one block must invalidate the assembled document even
 * though every other block's bytes are unchanged.
 *
 * Sets are SORTED before they are stringified. Their insertion order is not a
 * fact about the output, and keying on it would make two identical documents
 * compare unequal — a cache that misses forever looks exactly like a cache that
 * works, until you measure it.
 */
export function renderOptionsKey(options: RenderOptions, width: number): string {
  const ids = (values: ReadonlySet<string> | undefined): string[] =>
    [...(values ?? [])].sort();
  return JSON.stringify({
    width,
    expanded: options.expanded,
    showToolResults: options.showToolResults,
    toolResultLines: options.toolResultLines,
    expandedBlockIds: ids(options.expandedBlockIds),
    collapsedBlockIds: ids(options.collapsedBlockIds),
    showThinking: options.showThinking !== false,
    selectedBlockId: options.selectedBlockId ?? null,
    theme: options.theme ?? null,
  });
}
