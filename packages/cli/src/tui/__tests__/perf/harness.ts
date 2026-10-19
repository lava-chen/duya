/**
 * Frame-latency harness for plan 615's Phase 0 baseline (V3/V4).
 *
 * ## What it measures, and why each one needs a real clock
 *
 * - **input → first byte**: how long a keystroke waits before anything reaches
 *   the terminal. The number the user experiences as "does typing feel stuck".
 * - **frame interval distribution**: the gap between consecutive frames while a
 *   response streams. The throttle is a trailing-edge 70ms timer, so the
 *   question is not the mean but the tail — a frame that arrives after 200ms is
 *   a visible stutter even if the average is fine.
 * - **10k-block `totalLines() + paint`**: whether the render loop is O(document)
 *   or O(visible viewport).
 *
 * All three are WALL-CLOCK measurements of the real pipeline, so the clock here
 * must stay `performance.now()`. Injecting a fake one would measure the fake,
 * which is the exact mistake `render-scheduler.ts` warns about in its own header
 * comment.
 *
 * ## Where the timestamps come from
 *
 * Each frame is wrapped in DECSET/DECRST 2026 (`SYNC_BEGIN`/`SYNC_END`), so the
 * output stream itself carries the frame boundaries. Tapping the stream rather
 * than instrumenting `paint()` keeps the measurement outside the code it is
 * measuring.
 *
 * ## Windows ConPTY
 *
 * `R-1` in the plan: ConPTY aggregates writes, which can add tens of
 * milliseconds that have nothing to do with the renderer. These numbers are
 * therefore measured on the stream *inside* the process — after the writer, but
 * before the OS — and are the right comparison for renderer-to-renderer work.
 * They are NOT a claim about perceived latency over ConPTY; that needs a real
 * terminal and belongs to the Phase 7 真机 matrix.
 */

import { PassThrough, Writable } from 'node:stream';

import { TUIApp } from '../../TUIApp.js';
import { detectTerminalEnvironment } from '../../terminal-env.js';
import { MIN_RENDER_INTERVAL_MS } from '../../render-scheduler.js';
import type { TranscriptModel } from '../../blocks.js';
import type { ScreenRenderer } from '../../screen/index.js';

const SYNC_BEGIN = '\u001b[?2026h';
const SYNC_END = '\u001b[?2026l';

/** One observed frame. */
export interface FrameSample {
  /** `performance.now()` when the frame's opening marker reached the stream. */
  readonly at: number;
  /** `performance.now()` when the closing marker did, or `at` if it never came. */
  readonly doneAt: number;
  /** Bytes in this frame, including both sync markers. */
  readonly bytes: number;
}

/** A TTY-shaped sink that timestamps every synchronized-output frame. */
export interface TappedOutput {
  readonly stream: Writable;
  readonly frames: FrameSample[];
  /** Total characters written, for a sanity check that frames actually happened. */
  totalBytes(): number;
  /** Close the frame still accumulating so its `bytes`/`doneAt` are final. */
  seal(): void;
}

/**
 * Wrap a writable so every DECSET/DECRST-2026 synchronized frame is timestamped.
 *
 * ## Why the OPENING marker is not enough
 *
 * `TUIApp.paint()` writes `SYNC_BEGIN`, paints, then writes `SYNC_END`. The
 * opening marker therefore lands at the START of painting, before a single
 * cell has been composed. A measurement keyed on it answers "when did the
 * scheduler decide to paint", not "when did the user see something" — and for
 * the input-latency number, which is the one users felt, that is the wrong
 * question. Both timestamps are recorded so each caller can pick the one its
 * question actually needs.
 *
 * ## Why `bytes` counts everything between the markers, including the tail
 *
 * `paint()` calls `fullScreen.render()` INSIDE the sync block, but neither
 * renderer writes there: blessed buffers into `_buf` and flushes on
 * `nextTick` (`program.js`), and the own renderer defers to a microtask. So
 * the pixels land AFTER `SYNC_END`, and a byte count taken strictly between
 * the markers reports ~0 for a 20 KB screen. `bytes` therefore spans from one
 * `SYNC_BEGIN` to the NEXT one — the window during which this frame's output
 * is actually on the wire.
 */
export function tapOutput(columns = 80, rows = 24): TappedOutput {
  const frames: FrameSample[] = [];
  let pending = '';
  let chars = 0;
  let openAt = -1;
  let openIndex = -1;
  const seal = (): void => {
    if (openIndex === -1) return;
    const frame = frames[openIndex] as { doneAt: number; bytes: number };
    frame.doneAt = performance.now();
    frame.bytes = chars;
    openIndex = -1;
  };
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const text = chunk.toString('utf8');
      chars += text.length;
      // A chunk may hold the tail of one frame and the head of the next, so the
      // scan runs over the carry-over rather than per chunk.
      const scan = pending + text;
      pending = '';
      let cursor = 0;
      for (;;) {
        const begin = scan.indexOf(SYNC_BEGIN, cursor);
        const end = scan.indexOf(SYNC_END, cursor);
        if (begin === -1 && end === -1) break;
        if (begin !== -1 && (end === -1 || begin < end)) {
          // The previous frame's output ends where this one starts.
          seal();
          openAt = performance.now();
          openIndex = frames.length;
          frames.push({ at: openAt, doneAt: openAt, bytes: 0 });
          cursor = begin + SYNC_BEGIN.length;
        } else {
          // The closing marker is a boundary, not the end of the output: the
          // pixels follow it (see above). Record it, but keep counting.
          cursor = end + SYNC_END.length;
        }
      }
      // Keep an unterminated marker's prefix so a marker split across chunks is
      // still recognised. Neither marker has a self-overlapping prefix, so the
      // longest possible partial is `SYNC_BEGIN.length - 1`.
      pending = scan.slice(Math.max(cursor, scan.length - SYNC_BEGIN.length + 1));
      callback();
    },
  }) as Writable & { isTTY?: boolean; columns?: number; rows?: number };
  stream.isTTY = true;
  stream.columns = columns;
  stream.rows = rows;
  return {
    stream,
    frames,
    totalBytes: () => chars,
    /** Close the frame still accumulating. Call before reading its `bytes`. */
    seal: () => seal(),
  };
}

export interface HarnessOptions {
  readonly renderer: ScreenRenderer;
  readonly columns?: number;
  readonly rows?: number;
  readonly inline?: boolean;
}

/** Fill the transcript so latency is measured on a realistic frame. */
export interface PrefillOptions {
  readonly blocks: number;
  readonly linesPerBlock: number;
}

export interface Harness {
  readonly app: TUIApp;
  readonly output: TappedOutput;
  readonly input: PassThrough;
  /** Feed one keystroke and wait until the frame carrying it is fully written. */
  type(text: string): Promise<KeystrokeLatency>;
  stop(): void;
}

/**
 * One keystroke's two latencies.
 *
 * `dispatch` is when painting BEGAN; `painted` is when the last byte of the
 * frame reached the stream. They answer different questions: `dispatch` is
 * "did input bypass the throttle", `painted` is "when was the character on
 * screen". Optimising the first while the second stays flat is optimising the
 * wrong end of the same frame.
 */
export interface KeystrokeLatency {
  readonly dispatch: number;
  readonly painted: number;
}

const settleFrame = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

export function makeHarness(options: HarnessOptions): Harness {
  const output = tapOutput(options.columns ?? 80, options.rows ?? 24);
  const input = new PassThrough();
  const app = new TUIApp({
    input,
    output: output.stream,
    // Full-screen is where the renderer owns every cell; the inline path has a
    // single implementation and nothing to compare.
    inline: options.inline ?? false,
    renderer: options.renderer,
    keyOverrides: {},
    terminalEnv: detectTerminalEnvironment({
      TERM: 'xterm-256color',
      TERM_PROGRAM: 'WezTerm',
      COLORTERM: 'truecolor',
      LANG: 'en_US.UTF-8',
    }),
    onSubmit: () => {},
  });
  app.start();

  return {
    app,
    output,
    input,
    async type(text: string): Promise<KeystrokeLatency> {
      // Drain anything already queued: a frame left over from setup would be
      // counted as this keystroke's response and report a suspiciously fast
      // number. `settleFrame` yields to the timer queue, where both renderers'
      // deferred writes run.
      for (let guard = 0; guard < 100; guard += 1) {
        const stale = output.frames.at(-1);
        if (stale === undefined) break;
        output.seal();
        if (stale.doneAt > stale.at) break;
        await settleFrame();
      }

      const before = output.frames.length;
      const charsBefore = output.totalBytes();
      const startedAt = performance.now();
      input.write(text);
      // Wait for the frame this keystroke caused rather than a fixed sleep:
      // the measured number IS the wait, so a sleep long enough to be safe
      // would make every sample that constant.
      while (output.frames.length === before) {
        await settleFrame();
      }
      const frame = output.frames[before]!;
      // The pixels land AFTER `SYNC_END`, and the next frame's `SYNC_BEGIN` is
      // what proves this one is complete. Failing that, a quiet spell is the
      // same thing — a trailing-edge throttle cannot start another frame
      // inside one — so the wait is bounded either way.
      const quietMs = Math.max(4, Math.ceil(MIN_RENDER_INTERVAL_MS / 4));
      const deadline = performance.now() + quietMs * 4;
      let lastGrowthAt = performance.now();
      let lastChars = output.totalBytes();
      while (performance.now() < deadline) {
        // A subsequent frame means this one is definitely over.
        if (output.frames.length > before + 1) break;
        if (output.totalBytes() !== lastChars) {
          lastChars = output.totalBytes();
          lastGrowthAt = performance.now();
        } else if (performance.now() - lastGrowthAt >= quietMs) {
          break;
        }
        await settleFrame();
      }
      output.seal();
      return { dispatch: frame.at - startedAt, painted: frame.doneAt - startedAt };
    },
    stop: () => app.stop(),
  };
}

/** Percentile of a sample set, nearest-rank. Empty input yields 0. */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, rank)]!;
}

export function summarize(values: readonly number[]): {
  count: number;
  p50: number;
  p95: number;
  max: number;
} {
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length === 0 ? 0 : Math.max(...values),
  };
}

export interface InputLatencyReport {
  readonly renderer: string;
  readonly columns: number;
  readonly rows: number;
  readonly samples: number;
  /** Input → painting began. Shows whether input bypasses the throttle. */
  readonly dispatchP50: number;
  readonly dispatchP95: number;
  /** Input → last byte of the frame on the stream. The felt latency. */
  readonly paintedP50: number;
  readonly paintedP95: number;
  readonly paintedMax: number;
  /** Size of a typical frame. Context for the timing: 200 B and 20 KB differ. */
  readonly frameBytesP50: number;
}

/**
 * Type `keystrokes` characters into a fresh app and report input→frame times.
 *
 * The FIRST keystroke is dropped from the sample: `start()` renders the initial
 * frame and the first paint after it pays for blessed's element construction,
 * which no later keystroke pays again. Keeping it would report startup cost as
 * typing cost.
 *
 * ## Why the transcript is prefilled
 *
 * An empty session paints a handful of box rows, so its frames are ~200 bytes
 * and the number mostly measures `write()` on a no-op stream — the pipeline
 * never gets to show its cost. `prefill` puts real content in the transcript
 * first, so the measured frame includes a full viewport of styled rows, which
 * is what typing during a conversation actually costs.
 */
export async function measureInputLatency(
  renderer: ScreenRenderer,
  keystrokes = 20,
  prefill: PrefillOptions | null = { blocks: 40, linesPerBlock: 6 },
): Promise<InputLatencyReport> {
  const harness = makeHarness({ renderer });
  try {
    await settleFrame();
    if (prefill !== null) {
      buildDocument(harness.app, prefill.blocks, prefill.linesPerBlock);
      // Let the document's own frame go out before sampling; otherwise the
      // first keystroke would be measured while a large frame is still queued.
      await new Promise<void>((resolve) => setTimeout(resolve, MIN_RENDER_INTERVAL_MS * 3));
    }
    const dispatch: number[] = [];
    const painted: number[] = [];
    const byteCounts: number[] = [];
    for (let index = 0; index < keystrokes; index += 1) {
      const before = harness.output.frames.length;
      const latency = await harness.type('a');
      if (index > 0) {
        dispatch.push(latency.dispatch);
        painted.push(latency.painted);
        byteCounts.push(harness.output.frames[before]?.bytes ?? 0);
      }
    }
    const d = summarize(dispatch);
    const p = summarize(painted);
    return {
      renderer,
      columns: 80,
      rows: 24,
      samples: painted.length,
      dispatchP50: d.p50,
      dispatchP95: d.p95,
      paintedP50: p.p50,
      paintedP95: p.p95,
      paintedMax: p.max,
      frameBytesP50: summarize(byteCounts).p50,
    };
  } finally {
    harness.stop();
  }
}

export interface StreamFrameReport {
  readonly renderer: string;
  readonly deltas: number;
  readonly frames: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  /** Share of frames that arrived inside the throttle's own interval. */
  readonly withinInterval: number;
}

/**
 * Push `deltas` text deltas through the model and report frame gap statistics.
 *
 * The deltas are spaced by `spacingMs` so the throttle sees an actual stream
 * rather than one lumped burst: with everything in one tick the trailing-edge
 * timer would collapse it to a single frame and the distribution would be a
 * measurement of `setTimeout`, not of the pipeline.
 */
export async function measureStreamFrames(
  renderer: ScreenRenderer,
  deltas = 60,
  spacingMs = 4,
): Promise<StreamFrameReport> {
  const harness = makeHarness({ renderer });
  try {
    await settleFrame();
    const before = harness.output.frames.length;
    for (let index = 0; index < deltas; index += 1) {
      harness.app.push({ type: 'text_delta', data: { content: 'token ' } });
      if (spacingMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, spacingMs));
      }
    }
    // Let the trailing edge fire.
    await new Promise<void>((resolve) =>
      setTimeout(resolve, MIN_RENDER_INTERVAL_MS * 2),
    );
    const frames = harness.output.frames.slice(before);
    const gaps: number[] = [];
    for (let index = 1; index < frames.length; index += 1) {
      gaps.push(frames[index]!.at - frames[index - 1]!.at);
    }
    return {
      renderer,
      deltas,
      frames: frames.length,
      ...summarize(gaps),
      withinInterval: gaps.length === 0
        ? 0
        : gaps.filter((gap) => gap <= MIN_RENDER_INTERVAL_MS * 1.5).length / gaps.length,
    };
  } finally {
    harness.stop();
  }
}

/**
 * Build a transcript with `blocks` assistant blocks, each `linesPerBlock` lines.
 *
 * Uses `model.apply` — the exact function `TUIApp.push` calls — rather than
 * `app.push`. There is no "add a block" frame: a block exists because deltas
 * created it and a final frame sealed it, so a benchmark that skipped that
 * shape would measure a document the CLI cannot produce.
 *
 * `app.push` is deliberately NOT used: deltas there land in a throttle buffer
 * and reach the model on a timer, so building 300 blocks would take 300
 * pacing intervals of real time. `apply` is the same call the buffer
 * eventually makes, so the resulting model is identical and the construction
 * cost disappears from the measurement.
 *
 * Block identity is `{messageId, index}`, read by `readBlockKey`. A payload
 * without `messageId` yields `null`, and every delta then lands on the one
 * live block — a single enormous block, which is a far cheaper shape to lay
 * out and would flatter the numbers.
 */
export function buildDocument(
  app: TUIApp,
  blocks: number,
  linesPerBlock: number,
): void {
  const model = (app as unknown as { model: TranscriptModel }).model;
  for (let index = 0; index < blocks; index += 1) {
    const body = Array.from(
      { length: linesPerBlock },
      (_, line) => `line ${line} of block ${index}`,
    ).join('\n');
    const data = { content: body, messageId: `perf-${index}`, index: 0 };
    model.apply({ type: 'text_delta', data });
    model.apply({ type: 'text', data });
  }
  // The renderer keys off the model, not off `push`, so it needs no prompt —
  // but the app's own cached line array does, and the next render would
  // otherwise lay out an empty transcript.
  (app as unknown as { noteTranscriptMutation(): void }).noteTranscriptMutation();
  (app as unknown as { scheduleRender(): void }).scheduleRender();
}
