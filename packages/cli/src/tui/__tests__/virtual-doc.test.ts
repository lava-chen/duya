/**
 * Incremental layout and the virtualised document (plan 615 Phase 4).
 *
 * ## The claim being pinned
 *
 * A transcript does not stop growing, and the render loop must not grow with it.
 * Two properties make that true, and both are asserted here instead of being
 * argued for in a comment:
 *
 * 1. **The window is a query, not an accumulation.** `visibleWindow()` answers
 *    "which lines are on screen" from per-block heights, so full-screen slicing
 *    and inline scrollback commit read the same answer.
 * 2. **Painting costs the viewport, not the document.** With a warm cache, a
 *    frame over 10,000 blocks renders no markdown and writes only the blocks on
 *    screen — `blocksPainted` is bounded by the row count, and a cold miss count
 *    of 0 is what proves the cache did the rest.
 */

import { describe, expect, it } from 'vitest';

import { SceneCanvas } from '../core/component.js';
import { MeasureCache, resetMeasureStats } from '../core/measure.js';
import { visibleWindow } from '../core/visible-window.js';
import { leaf } from '../core/component.js';
import { VStack } from '../core/containers.js';
import { update } from '../core/component.js';
import { TranscriptPane } from '../components/transcript-pane.js';
import { TranscriptModel } from '../blocks.js';
import { TranscriptRenderer } from '../transcript-cache.js';
import { DEFAULT_RENDER_OPTIONS, type RenderOptions } from '../transcript-view.js';
import { tagsToSpans } from '../core/tags.js';
import { spanText } from '../core/span.js';

/** A model of `count` assistant blocks, each exactly one line. */
function modelOf(count: number): TranscriptModel {
  const model = new TranscriptModel();
  for (let index = 0; index < count; index += 1) {
    const body = `b${index}`;
    const data = { content: body, messageId: `m${index}`, index: 0 };
    model.apply({ type: 'text_delta', data });
    model.apply({ type: 'text', data });
  }
  return model;
}

const OPTIONS: RenderOptions = { ...DEFAULT_RENDER_OPTIONS, renderer: 'own' };

/** One document line as the text a cell would show, tags stripped. */
function plainLine(renderer: TranscriptRenderer, model: TranscriptModel, index: number): string {
  const lines = renderer.lines(model, { ...OPTIONS, width: 80 });
  return spanText(tagsToSpans(lines[index] ?? '')).trimEnd();
}

describe('visibleWindow', () => {
  const heights = [3, 2, 0, 4];

  it('ends at the newest line when the reader is following', () => {
    const window = visibleWindow(heights, 4, 0, true);
    expect(window.totalLines).toBe(9);
    expect(window.maxStart).toBe(5);
    expect(window.lineStart).toBe(5);
    expect(window.lineEnd).toBe(9);
    expect(window.following).toBe(true);
  });

  it('moves the window up by the scroll offset', () => {
    // The offset is absolute: line 3 from the TOP, not two lines back from the
    // newest one.
    const window = visibleWindow(heights, 4, 3, false);
    expect(window.lineStart).toBe(3);
    expect(window.lineEnd).toBe(7);
    expect(window.following).toBe(false);
  });

  it('keeps the window on the content while the document grows', () => {
    // The reader scrolled up to line 3. Two more lines arrive at the bottom,
    // and the window must stay on line 3 — an offset counted from the tail
    // would have dragged the viewport along with the newest line.
    const before = visibleWindow(heights, 4, 3, false);
    const grown = visibleWindow([...heights, 2], 4, 3, false);
    expect(grown.lineStart).toBe(before.lineStart);
    expect(grown.lineStart).toBe(3);
  });

  it('pins the window to the newest line while following', () => {
    const window = visibleWindow([...heights, 2], 4, 3, true);
    expect(window.lineStart).toBe(window.maxStart);
    expect(window.lineStart).toBe(7);
  });

  it('clamps a scroll past the top instead of reporting a negative start', () => {
    // The offset counts from the TOP, so a negative one is past the top.
    const window = visibleWindow(heights, 4, -10, false);
    expect(window.lineStart).toBe(0);
    expect(window.lineEnd).toBe(4);
  });

  it('clamps a scroll past the bottom to the newest line', () => {
    const window = visibleWindow(heights, 4, 10_000, false);
    expect(window.lineStart).toBe(5);
    expect(window.lineEnd).toBe(9);
  });

  it('reports an empty document as empty, not as one blank line', () => {
    const window = visibleWindow([], 4, 0, true);
    expect(window).toMatchObject({ totalLines: 0, lineStart: 0, lineEnd: 0, firstBlock: 0, lastBlock: 0 });
  });

  it('names the blocks the window intersects, skipping zero-height ones', () => {
    // Window [3, 7): line 3 is inside block 1 (lines 3..4), and the empty block
    // 2 sits at line 5. It must not be dragged in: it has nothing to paint.
    expect(visibleWindow(heights, 4, 3, false).firstBlock).toBe(1);
    expect(visibleWindow(heights, 4, 3, false).lastBlock).toBe(4);

    // A window entirely inside block 3 (lines 5..8) names only that block.
    expect(visibleWindow(heights, 2, 6, false)).toMatchObject({ lineStart: 6, firstBlock: 3, lastBlock: 4 });
  });

  it('never reports a window wider than the document', () => {
    const window = visibleWindow([1, 1], 24, 0, true);
    expect(window.lineStart).toBe(0);
    expect(window.lineEnd).toBe(2);
  });
});

describe('MeasureCache', () => {
  it('serves the second measure from the cache', () => {
    const cache = new MeasureCache();
    const node = leaf('a', () => 7, () => {});
    expect(cache.measure(node, 80)).toBe(7);
    expect(cache.measure(node, 80)).toBe(7);
    expect(cache.stats).toEqual({ hits: 1, misses: 1 });
  });

  it('recomputes when the component is updated', () => {
    const cache = new MeasureCache();
    const node = leaf('a', () => 7, () => {});
    cache.measure(node, 80);
    update(node, undefined);
    resetMeasureStats(cache);
    cache.measure(node, 80);
    expect(cache.stats).toEqual({ hits: 0, misses: 1 });
  });

  it('recomputes when the width changes', () => {
    const cache = new MeasureCache();
    const node = leaf('a', (width) => width, () => {});
    cache.measure(node, 80);
    resetMeasureStats(cache);
    expect(cache.measure(node, 40)).toBe(40);
    expect(cache.stats).toEqual({ hits: 0, misses: 1 });
  });

  it('recomputes a container when a CHILD is updated', () => {
    // The bug this exists to prevent: keying only on the container's own
    // revision, which does not change when something under it does.
    const cache = new MeasureCache();
    const child = leaf('child', (width) => (width < 50 ? 1 : 2), () => {});
    const stack = new VStack('stack', [{ component: child, size: 'flex' }]);
    expect(cache.measure(stack, 80)).toBe(2);

    update(child, undefined);
    resetMeasureStats(cache);
    expect(cache.measure(stack, 40)).toBe(1);
    expect(cache.stats.misses).toBe(1);
  });
});

describe('TranscriptPane', () => {
  it('measures the whole document but paints only the window', () => {
    const model = modelOf(200);
    const renderer = new TranscriptRenderer();
    const pane = new TranscriptPane({ renderer, model, options: OPTIONS, scrollTop: 0, following: true });
    // A block is not one line: the renderer owns that decision, so the document
    // height is asked for rather than assumed.
    expect(pane.measure(80)).toBe(renderer.totalLines(model, { ...OPTIONS, width: 80 }));

    const canvas = new SceneCanvas(80, 10);
    pane.paint(canvas, { row: 0, column: 0, width: 80, height: 10 });
    const window = pane.window(80, 10);
    expect(canvas.textAt(0).trimEnd()).toBe(plainLine(renderer, model, window.lineStart));
    expect(canvas.textAt(9).trimEnd()).toBe(plainLine(renderer, model, window.lineEnd - 1));
    expect(pane.stats.blocksPainted).toBeLessThanOrEqual(11);
    expect(pane.stats.linesPainted).toBe(10);
  });

  it('shows older lines when the reader scrolls back', () => {
    const model = modelOf(200);
    const renderer = new TranscriptRenderer();
    const pane = new TranscriptPane({ renderer, model, options: OPTIONS, scrollTop: 0, following: false });
    const canvas = new SceneCanvas(80, 10);
    pane.paint(canvas, { row: 0, column: 0, width: 80, height: 10 });
    const window = pane.window(80, 10);
    // The reader scrolled back to the top, and the same query answers it
    // without a second window implementation to disagree with.
    expect(window.lineStart).toBe(0);
    expect(window.following).toBe(false);
    expect(canvas.textAt(0).trimEnd()).toBe(plainLine(renderer, model, window.lineStart));
  });

  it('paints nothing beyond the viewport, even when the window is taller', () => {
    const model = modelOf(5);
    const pane = new TranscriptPane({ renderer: new TranscriptRenderer(), model, options: OPTIONS, scrollTop: 0, following: true });
    const canvas = new SceneCanvas(20, 4);
    pane.paint(canvas, { row: 0, column: 0, width: 20, height: 4 });
    expect(pane.stats.linesPainted).toBe(4);
  });
});

describe('10k blocks', () => {
  const BLOCKS = 10_000;

  it('paints the viewport for a cost bounded by the viewport', () => {
    const model = modelOf(BLOCKS);
    const renderer = new TranscriptRenderer();
    const pane = new TranscriptPane({ renderer, model, options: OPTIONS, scrollTop: 0, following: true });

    // Warm the cache once: this is the frame where the markdown work happens.
    expect(pane.measure(80)).toBe(renderer.totalLines(model, { ...OPTIONS, width: 80 }));
    expect(renderer.stats.misses).toBe(BLOCKS);

    const canvas = new SceneCanvas(80, 24);
    const missesBefore = renderer.stats.misses;
    pane.paint(canvas, { row: 0, column: 0, width: 80, height: 24 });

    // The O(visible) claim, in two numbers: no markdown re-rendered, and the
    // blocks touched are the ones on screen rather than the document.
    expect(renderer.stats.misses - missesBefore).toBe(0);
    expect(pane.stats.blocksPainted).toBeLessThanOrEqual(25);
    expect(pane.stats.linesPainted).toBe(24);
    expect(canvas.textAt(23)).toContain(`b${BLOCKS - 1}`);
  });

  it('repaints the same window for free', () => {
    const model = modelOf(BLOCKS);
    const renderer = new TranscriptRenderer();
    const pane = new TranscriptPane({ renderer, model, options: OPTIONS, scrollTop: 0, following: true });
    pane.measure(80);
    const hitsBefore = renderer.stats.hits;

    pane.paint(new SceneCanvas(80, 24), { row: 0, column: 0, width: 80, height: 24 });
    // Every block was a cache hit: a frame that changes nothing renders nothing.
    expect(renderer.stats.hits - hitsBefore).toBeGreaterThanOrEqual(BLOCKS);
    expect(renderer.stats.misses).toBe(BLOCKS);
  });
});

describe('component revisions in the cache key', () => {
  it('re-renders a block whose component revision changed', () => {
    const model = modelOf(3);
    const renderer = new TranscriptRenderer();
    renderer.totalLines(model, OPTIONS);
    const missesAfterWarm = renderer.stats.misses;

    // Same content, different component revision: the height may have changed,
    // so the cached lines cannot be trusted. Ids come from the model because
    // block ids are a module-level sequence, not a per-test counter.
    const first = model.blocks[0]?.id ?? '';
    const revisions = new Map([[first, 1]]);
    renderer.totalLines(model, { ...OPTIONS, componentRevisions: revisions });
    expect(renderer.stats.misses).toBeGreaterThan(missesAfterWarm);

    // And the revision is part of the key, so switching back is a hit again.
    const missesBeforeRepeat = renderer.stats.misses;
    renderer.totalLines(model, { ...OPTIONS, componentRevisions: new Map([[first, 1]]) });
    expect(renderer.stats.misses).toBe(missesBeforeRepeat);
  });
});
