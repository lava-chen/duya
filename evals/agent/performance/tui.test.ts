import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import { TranscriptModel } from '../../../packages/cli/src/tui/blocks.ts';
import { MIN_RENDER_INTERVAL_MS } from '../../../packages/cli/src/tui/render-scheduler.ts';
import { TranscriptRenderer } from '../../../packages/cli/src/tui/transcript-cache.ts';
import { DEFAULT_RENDER_OPTIONS } from '../../../packages/cli/src/tui/transcript-view.ts';
import {
  makeHarness,
  measureInputLatency,
  measureStreamFrames,
  summarize,
} from '../../../packages/cli/src/tui/__tests__/perf/harness.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const REPORT_PATH = process.env['EVAL_TUI_OUT']
  ? resolve(process.env['EVAL_TUI_OUT'])
  : resolve(HERE, '../reports/tui-latest.json');
const SETTLE_MS = 16;

async function sourceMetadata(): Promise<{ commit: string; branch: string }> {
  const gitEntry = resolve(REPO_ROOT, '.git');
  const gitDir = (await lstat(gitEntry)).isDirectory()
    ? gitEntry
    : resolve(REPO_ROOT, (await readFile(gitEntry, 'utf8')).trim().replace(/^gitdir:\s*/, ''));
  let commonDir = gitDir;
  try { commonDir = resolve(gitDir, (await readFile(resolve(gitDir, 'commondir'), 'utf8')).trim()); } catch {}
  const head = (await readFile(resolve(gitDir, 'HEAD'), 'utf8')).trim();
  if (!head.startsWith('ref: ')) return { commit: head, branch: 'detached' };
  const ref = head.slice('ref: '.length);
  try {
    return {
      commit: (await readFile(resolve(gitDir, ref), 'utf8')).trim(),
      branch: ref.replace(/^refs\/heads\//, ''),
    };
  } catch {
    try {
      return {
        commit: (await readFile(resolve(commonDir, ref), 'utf8')).trim(),
        branch: ref.replace(/^refs\/heads\//, ''),
      };
    } catch {}
    const packed = await readFile(resolve(commonDir, 'packed-refs'), 'utf8');
    const line = packed.split('\n').find((entry) => entry.endsWith(` ${ref}`));
    const commit = line?.split(' ')[0];
    if (!commit) throw new Error(`Cannot resolve git ref ${ref}`);
    return { commit, branch: ref.replace(/^refs\/heads\//, '') };
  }
}

async function measureFirstFrame(): Promise<{ dispatchMs: number; paintedMs: number; bytes: number }> {
  const startedAt = performance.now();
  const harness = makeHarness({ renderer: 'own', columns: 80, rows: 24 });
  const output = harness.output;
  try {
    const deadline = performance.now() + 5_000;
    while (output.frames.length === 0 && performance.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (output.frames.length === 0) throw new Error('TUI did not emit its initial frame');

    let previousBytes = output.totalBytes();
    let lastGrowthAt = performance.now();
    while (performance.now() - lastGrowthAt < SETTLE_MS && performance.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      const currentBytes = output.totalBytes();
      if (currentBytes !== previousBytes) {
        previousBytes = currentBytes;
        lastGrowthAt = performance.now();
      }
    }
    output.seal();
    const frame = output.frames[0]!;
    return {
      dispatchMs: frame.at - startedAt,
      paintedMs: frame.doneAt - startedAt,
      bytes: frame.bytes,
    };
  } finally {
    harness.stop();
  }
}

function measureTranscriptLayout(blockCount: number, linesPerBlock: number): {
  blocks: number;
  linesPerBlock: number;
  documentLines: number;
  coldTotalLinesMs: number;
  warmTotalLinesMs: number;
  coldMisses: number;
  warmMisses: number;
  warmHits: number;
} {
  const model = new TranscriptModel();
  for (let index = 0; index < blockCount; index += 1) {
    const content = Array.from({ length: linesPerBlock }, (_, line) =>
      `conversation line ${line} from assistant block ${index}`,
    ).join('\n');
    const data = { content, messageId: `tui-eval-${index}`, index: 0 };
    model.apply({ type: 'text_delta', data });
    model.apply({ type: 'text', data });
  }

  const renderer = new TranscriptRenderer();
  const options = { ...DEFAULT_RENDER_OPTIONS, width: 80, renderer: 'own' as const };
  const coldStartedAt = performance.now();
  const documentLines = renderer.totalLines(model, options);
  const coldTotalLinesMs = performance.now() - coldStartedAt;
  const coldMisses = renderer.stats.misses;
  const hitsBeforeWarm = renderer.stats.hits;
  const missesBeforeWarm = renderer.stats.misses;
  const warmStartedAt = performance.now();
  renderer.totalLines(model, options);
  const warmTotalLinesMs = performance.now() - warmStartedAt;
  return {
    blocks: blockCount,
    linesPerBlock,
    documentLines,
    coldTotalLinesMs,
    warmTotalLinesMs,
    coldMisses,
    warmMisses: renderer.stats.misses - missesBeforeWarm,
    warmHits: renderer.stats.hits - hitsBeforeWarm,
  };
}

async function repeatFirstFrame(samples: number) {
  const observations = [];
  for (let index = 0; index < samples; index += 1) observations.push(await measureFirstFrame());
  return {
    samples,
    dispatchMs: summarize(observations.map((item) => item.dispatchMs)),
    paintedMs: summarize(observations.map((item) => item.paintedMs)),
    firstFrameBytes: summarize(observations.map((item) => item.bytes)),
    observations,
  };
}

describe('Agent TUI performance evaluation', () => {
  it('writes a reproducible TUI interaction and rendering report', async () => {
    const cpuBefore = process.cpuUsage();
    const memoryBefore = process.memoryUsage();
    const startedAt = performance.now();

    // Startup is measured in-process from TUI construction to the first complete
    // output frame. Keystrokes use the production input/render path on a filled
    // transcript; streaming exercises the production event-to-frame scheduler.
    const startup = await repeatFirstFrame(5);
    const input = await measureInputLatency('own', 20, { blocks: 40, linesPerBlock: 6 });
    const stream = await measureStreamFrames('own', 80, 4);
    const transcript = [
      measureTranscriptLayout(2_000, 2),
      measureTranscriptLayout(10_000, 2),
    ];

    const cpuDelta = process.cpuUsage(cpuBefore);
    const memoryAfter = process.memoryUsage();
    const report = {
      schemaVersion: 1,
      kind: 'agent-tui-performance',
      scope: 'in-process production TUIApp and TranscriptRenderer on an 80x24 terminal stream; excludes CLI bundle/module cold start, operating-system terminal emulation, Host/Worker startup and model/provider time',
      createdAt: new Date().toISOString(),
      source: {
        ...await sourceMetadata(),
      },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        renderer: 'own',
        columns: 80,
        rows: 24,
        throttleIntervalMs: MIN_RENDER_INTERVAL_MS,
      },
      workload: {
        inputSamples: input.samples,
        inputPrefillBlocks: 40,
        inputPrefillLinesPerBlock: 6,
        streamDeltas: stream.deltas,
        streamSpacingMs: 4,
        transcriptBlockCounts: transcript.map((item) => item.blocks),
      },
      startup,
      inputLatency: input,
      streamFrames: stream,
      transcriptLayout: transcript,
      suiteDurationMs: performance.now() - startedAt,
      processCpuTimeMs: (cpuDelta.user + cpuDelta.system) / 1000,
      rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
      heapUsedDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
    };

    expect(startup.paintedMs.count).toBe(5);
    expect(startup.firstFrameBytes.p50).toBeGreaterThan(0);
    expect(input.samples).toBeGreaterThan(0);
    expect(stream.frames).toBeGreaterThan(1);
    expect(stream.outputBytes).toBeGreaterThan(0);
    expect(transcript[1]!.documentLines).toBeGreaterThan(transcript[0]!.documentLines);
    expect(transcript.every((item) => item.warmMisses === 0)).toBe(true);

    await mkdir(dirname(REPORT_PATH), { recursive: true });
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`TUI performance report: ${REPORT_PATH}`);
    console.log(JSON.stringify({
      startupMsP50: startup.paintedMs.p50,
      inputPaintedMsP50: input.paintedP50,
      inputPaintedMsP95: input.paintedP95,
      streamFrames: stream.frames,
      streamOutputBytes: stream.outputBytes,
      transcriptLayoutMs: transcript.map((item) => item.coldTotalLinesMs),
    }));
  }, 120_000);
});
