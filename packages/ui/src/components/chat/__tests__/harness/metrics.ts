/**
 * In-page instrumentation for the streaming-render benchmark.
 *
 * Metric names follow the project perf contract
 * (docs/exec-plans/active/2026-10-23-desktop-performance-hill-climbing.md):
 *
 *   frame.p95_ms          p95 of adjacent requestAnimationFrame intervals
 *   stream.worstFreeze_ms longest single Long Task during the stream
 *   dom.mutations          childList mutation records
 *   commit.count           React commit count — a production build has no
 *                          React Profiler, so this is the sanctioned
 *                          MutationObserver change-batch proxy: one
 *                          MutationObserver callback = one batch of DOM
 *                          mutations produced by one commit.
 */

export interface RegionCounters {
  /** Mutation records (childList) seen in this region. */
  records: number;
  /** MutationObserver callback invocations (commit batches). */
  batches: number;
}

export interface BenchMetrics {
  frames: number;
  frameP95Ms: number;
  frameMaxMs: number;
  longTaskCount: number;
  longTaskTotalMs: number;
  longTaskMaxMs: number;
  mutations: {
    totalRecords: number;
    totalBatches: number;
    history: RegionCounters;
    stream: RegionCounters;
    code: RegionCounters;
  };
  domNodes: number;
  durationMs: number;
}

type RegionKey = 'history' | 'stream' | 'code';

function emptyRegion(): RegionCounters {
  return { records: 0, batches: 0 };
}

export interface Instrumentation {
  /** Start counting frames / long tasks from now. */
  reset(): void;
  /** Observe a DOM region; `key` names the region in the report. */
  observeRegion(key: RegionKey, target: Node | null): void;
  metrics(): BenchMetrics;
}

export function installInstrumentation(): Instrumentation {
  const frameIntervals: number[] = [];
  let frames = 0;
  let lastTs = 0;
  let longTaskCount = 0;
  let longTaskTotalMs = 0;
  let longTaskMaxMs = 0;
  let rafId = 0;
  let startedAt = performance.now();

  const regions: Record<RegionKey, RegionCounters> = {
    history: emptyRegion(),
    stream: emptyRegion(),
    code: emptyRegion(),
  };

  const longTaskObserver = new PerformanceObserver((list) => {
    // `getEntries()` rather than iterating the list directly: the root
    // tsconfig's DOM lib declares no iterator and no index signature on
    // `PerformanceObserverEntryList`, so both forms fail the repository
    // typecheck.
    for (const entry of list.getEntries()) {
      longTaskCount += 1;
      longTaskTotalMs += entry.duration;
      if (entry.duration > longTaskMaxMs) longTaskMaxMs = entry.duration;
    }
  });
  longTaskObserver.observe({ type: 'longtask', buffered: true });

  const onFrame = (ts: number) => {
    rafId = requestAnimationFrame(onFrame);
    if (lastTs > 0) frameIntervals.push(ts - lastTs);
    lastTs = ts;
    frames += 1;
  };
  rafId = requestAnimationFrame(onFrame);

  return {
    reset(): void {
      frameIntervals.length = 0;
      frames = 0;
      lastTs = 0;
      longTaskCount = 0;
      longTaskTotalMs = 0;
      longTaskMaxMs = 0;
      for (const region of Object.values(regions)) {
        region.records = 0;
        region.batches = 0;
      }
      startedAt = performance.now();
    },
    observeRegion(key, target): void {
      if (!target) return;
      const counters = regions[key];
      const observer = new MutationObserver((records) => {
        counters.records += records.length;
        counters.batches += 1;
      });
      observer.observe(target, { childList: true, subtree: true });
    },
    metrics(): BenchMetrics {
      const totalRecords = regions.history.records + regions.stream.records + regions.code.records;
      const totalBatches = regions.history.batches + regions.stream.batches + regions.code.batches;
      const sorted = [...frameIntervals].sort((a, b) => a - b);
      const p95 = sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
      return {
        frames,
        frameP95Ms: Number(p95.toFixed(2)),
        frameMaxMs: Number((sorted.length > 0 ? sorted[sorted.length - 1] : 0).toFixed(2)),
        longTaskCount,
        longTaskTotalMs,
        longTaskMaxMs,
        mutations: {
          totalRecords,
          totalBatches,
          history: { ...regions.history },
          stream: { ...regions.stream },
          code: { ...regions.code },
        },
        domNodes: document.getElementsByTagName('*').length,
        durationMs: performance.now() - startedAt,
      };
    },
  };
}
