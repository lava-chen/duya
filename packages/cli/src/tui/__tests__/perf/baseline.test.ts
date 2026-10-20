/**
 * Phase 0 baseline (plan 615 §8 V3/V4/V5).
 *
 * ## Why this is not a threshold test
 *
 * These are wall-clock numbers from whatever machine happens to run them.
 * Asserting `p95 < 30` would turn a slow CI box into a false red and invite
 * someone to relax the bound until it asserts nothing. The assertions here are
 * therefore about INVARIANTS (frames happen, gaps respect the throttle, the
 * document does not cost O(total)) and the numbers are REPORTED, to be written
 * into the plan's §8 table and compared between phases on the same machine.
 *
 * Set `DUYA_PERF_BASELINE=1` to print the JSON block the plan quotes.
 */

import { describe, expect, it } from 'vitest';

import { TranscriptModel } from '../../blocks.js';
import { TranscriptRenderer } from '../../transcript-cache.js';
import { MIN_RENDER_INTERVAL_MS } from '../../render-scheduler.js';
import { DEFAULT_RENDER_OPTIONS, type RenderOptions } from '../../transcript-view.js';
import {
  buildDocument,
  makeHarness,
  measureInputLatency,
  measureStreamFrames,
  summarize,
} from './harness.js';

const REPORT = process.env['DUYA_PERF_BASELINE'] === '1';

const SETTLE = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('TUI frame latency baseline', () => {
  // plan 615 Phase 7 removed the second renderer, so there is no comparison
  // left: these are the numbers the finished engine has to keep, not a
  // scoreboard against an implementation that no longer exists.
  it('measures input→first-byte', async () => {
    const own = await measureInputLatency('own');
    if (REPORT) console.log('INPUT_LATENCY ' + JSON.stringify({ own }));

    // An invariant, not a target: a keystroke must reach the terminal at all.
    // The exact ceiling lives in the plan, where it can be calibrated.
    expect(own.samples).toBeGreaterThan(0);
    // Deliberately loose. A tight bound here would turn a loaded CI box into a
    // false red; the real number is reported and compared between phases.
    expect(own.paintedP95).toBeLessThan(500);
    // Input must bypass the throttle. The invariant is not "under N ms" — the
    // paint cost is whatever the renderer and the machine make it (~31ms on
    // this box) — it is that the frame did NOT wait for a trailing-edge timer.
    // Waiting would show up as a painted time at or beyond the interval,
    // before any paint cost is paid.
    expect(own.paintedP50).toBeLessThan(MIN_RENDER_INTERVAL_MS);
    // And the dispatch must be effectively immediate: it happens on the input
    // event itself, before any timer or microtask.
    expect(own.dispatchP95).toBeLessThan(MIN_RENDER_INTERVAL_MS / 10);
    // The own renderer diffs the visible frame, so a keystroke can repaint only
    // a few cells. Still require enough ANSI output to prove the measurement
    // observed a real input repaint rather than an empty/no-op frame.
    expect(own.frameBytesP50).toBeGreaterThan(20);
  }, 60_000);

  it('measures stream frame gaps', async () => {
    const own = await measureStreamFrames('own');
    if (REPORT) console.log('STREAM_FRAMES ' + JSON.stringify({ own }));

    // More than one frame means the stream was actually paced rather than
    // collapsed into the final state — which is the property the throttle
    // exists for, and the one a naive change would silently lose.
    expect(own.frames).toBeGreaterThan(1);
    // No gap may be shorter than the throttle: a violation means something
    // bypassed `RenderScheduler` and is rendering per delta.
    expect(own.p50).toBeGreaterThanOrEqual(MIN_RENDER_INTERVAL_MS * 0.9);
  }, 60_000);

  it('keeps totalLines() linear in blocks rather than quadratic', () => {
    const small = measureDocument(200, 10);
    const large = measureDocument(2000, 10);
    if (REPORT) console.log('DOCUMENT ' + JSON.stringify({ small, large }));

    // Ten times the blocks must not cost a hundred times the work. A generous
    // factor: this is guarding against an accidental O(n^2) (re-running the
    // full document through the markdown layer per block), not against
    // constant-factor noise.
    expect(large.lines).toBeGreaterThan(small.lines * 5);
    expect(large.ms).toBeLessThan(Math.max(small.ms * 30, 50));
  }, 60_000);

  it('does not re-render blocks outside the visible window', async () => {
    const harness = makeHarness({ renderer: 'own' });
    try {
      await SETTLE();
      buildDocument(harness.app, 300, 4);
      await new Promise<void>((resolve) => setTimeout(resolve, MIN_RENDER_INTERVAL_MS * 3));

      const model = (harness.app as unknown as { model: TranscriptModel }).model;
      const renderer = (harness.app as unknown as { transcript: TranscriptRenderer }).transcript;
      const options = RENDER_OPTIONS;

      // Prime the cache: the first pass has to render every block, so only the
      // SECOND pass can show whether the per-block cache is doing its job.
      renderer.totalLines(model, options);
      const missesBefore = renderer.stats.misses;
      const hitsBefore = renderer.stats.hits;

      const startedAt = performance.now();
      const lines = renderer.totalLines(model, options);
      const elapsed = performance.now() - startedAt;
      const newMisses = renderer.stats.misses - missesBefore;
      const newHits = renderer.stats.hits - hitsBefore;
      if (REPORT) {
        console.log('TOTAL_LINES ' + JSON.stringify({ blocks: 300, lines, ms: elapsed, newMisses, newHits }));
      }

      expect(lines).toBeGreaterThan(0);
      // An unchanged document must come entirely from the cache. `totalLines`
      // is allowed to touch every block ONCE — it has to, to know the
      // document's height — but touching means a key comparison, not a
      // markdown re-render. A miss here means the cache key is unstable
      // (something time- or order-dependent leaked into it), which would make
      // every frame pay for the whole transcript.
      expect(newMisses).toBe(0);
      expect(newHits).toBe(renderer.blocks(model, options).length);
    } finally {
      harness.stop();
    }
  }, 60_000);
});

/**
 * The render options every measurement folds to.
 *
 * `expanded: false` is the realistic default and the CHEAPER shape, so the
 * numbers here are a floor rather than a worst case; the expensive shapes
 * (expanded thinking, tool results) are bounded by the same per-block cache
 * and were not what made the loop O(document).
 *
 * `theme` is DELIBERATELY omitted: `RenderOptions.theme` is a `ThemeTags`
 * (token → tag body), and passing a `Styles` (token → function) instead makes
 * every tag body a stringified function. Test files are excluded from
 * `tsc -b`, so the compiler does not catch that; the first version of this
 * constant did exactly that and silently measured a document rendered with
 * garbage markup.
 */
const RENDER_OPTIONS: RenderOptions = {
  ...DEFAULT_RENDER_OPTIONS,
  width: 80,
  renderer: 'own',
};

function measureDocument(blocks: number, linesPerBlock: number): { blocks: number; lines: number; ms: number } {
  const model = new TranscriptModel();
  for (let index = 0; index < blocks; index += 1) {
    const body = Array.from(
      { length: linesPerBlock },
      (_, line) => `line ${line} of block ${index}`,
    ).join('\n');
    // Deliberately NOT `buildDocument`: that one starts from a live TUIApp,
    // which schedules a render. Here the question is purely what
    // `totalLines()` costs for N blocks with a cold cache, so the model is
    // filled through `apply` — the same call the app's own frame path uses —
    // without any shell around it.
    const data = { content: body, messageId: `perf-${index}`, index: 0 };
    model.apply({ type: 'text_delta', data });
    model.apply({ type: 'text', data });
  }
  const renderer = new TranscriptRenderer();
  const startedAt = performance.now();
  const lines = renderer.totalLines(model, RENDER_OPTIONS);
  const elapsed = performance.now() - startedAt;
  return { blocks, lines, ms: elapsed };
}

// Kept referenced so the helper list does not drift from what is exported.
void summarize;
