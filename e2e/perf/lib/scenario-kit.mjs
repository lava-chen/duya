/**
 * e2e/perf/lib/scenario-kit.mjs — the shared measurement plumbing.
 *
 * Every scenario measures the same way: reset the collector, let the product
 * do the work, read the collector back, and turn the observation into the
 * metric names of the contract. The naming and the unit are fixed here so
 * two agents measuring different journeys still produce comparable numbers.
 */
import { frameIntervals, percentile, round, sum } from './metrics.mjs';
import { readCollector, readHeapUsage, readPerformanceMetrics, resetCollector } from './collector.mjs';

/**
 * Turn a collector snapshot into the metric names of the contract.
 *
 * `extra` carries the scenario-specific names (a streaming window reports
 * `stream.block_ms_total`, a boot reports `startup.firstPaint_ms`); the
 * generic names are always present so a reader can compare journeys.
 */
export function snapshotToMetrics(snapshot, extra = {}) {
  if (!snapshot) return { ...extra };
  const intervals = frameIntervals(snapshot.frames);
  const durations = snapshot.longTasks.map((task) => task.duration);
  const keyLatencies = snapshot.keyLatencies.map((entry) => entry.latency);
  return {
    'frame.p50_ms': round(percentile(intervals, 0.5)),
    'frame.p95_ms': round(percentile(intervals, 0.95)),
    'frame.max_ms': round(intervals.length > 0 ? Math.max(...intervals) : null),
    'longtask.count': snapshot.longTasks.length,
    'longtask.total_ms': round(sum(durations)),
    'longtask.worst_ms': round(durations.length > 0 ? Math.max(...durations) : null),
    'commit.count': snapshot.mutationBatches,
    'dom.mutations': snapshot.mutationRecords,
    'dom.nodes': snapshot.domNodes,
    'interact.p50_ms': round(percentile(keyLatencies, 0.5)),
    'interact.p95_ms': round(percentile(keyLatencies, 0.95)),
    'interact.samples': keyLatencies.length,
    ...extra,
  };
}

/** Reset the collector and wait for the window to elapse. */
export async function measureWindow(page, windowMs) {
  await resetCollector(page);
  const startedAt = Date.now();
  if (windowMs > 0) await page.waitForTimeout(windowMs);
  const snapshot = await readCollector(page);
  return { snapshot, wallMs: Date.now() - startedAt };
}

/**
 * The renderer heap and CPU counters around a window.
 *
 * `cpu.renderer_pct` is the renderer's busy fraction: the CDP TaskDuration
 * delta divided by the elapsed wall time. It is a renderer-side number and
 * does not include the main process or the GPU process.
 */
export async function sampleResourceUsage(cdp, windowMs) {
  const before = await readPerformanceMetrics(cdp);
  const heapBefore = await readHeapUsage(cdp);
  const beforeAt = Date.now();
  const elapsedMs = windowMs > 0 ? windowMs : Date.now() - beforeAt;
  const after = await readPerformanceMetrics(cdp);
  const heapAfter = await readHeapUsage(cdp);
  const taskDelta =
    before?.taskDurationS !== null && before?.taskDurationS !== undefined
      && after?.taskDurationS !== null && after?.taskDurationS !== undefined
      ? after.taskDurationS - before.taskDurationS
      : null;
  const rendererPct = taskDelta === null || elapsedMs <= 0
    ? null
    : (taskDelta / (elapsedMs / 1000)) * 100;
  return {
    heapBefore,
    heapAfter,
    perfBefore: before,
    perfAfter: after,
    rendererPct: round(rendererPct),
    elapsedMs,
  };
}

/**
 * The memory metrics of the contract.
 *
 * `mem.peakMB` is the highest heap reading observed during the window and
 * `mem.growthMB` the difference between the last and the first one. The
 * window readings are the ones taken by the scenario; a scenario that only
 * samples the endpoints reports those.
 */
export function memoryMetrics(readings) {
  const used = readings
    .map((reading) => reading?.usedMB)
    .filter((value) => Number.isFinite(value));
  if (used.length === 0) return { 'mem.peakMB': null, 'mem.growthMB': null };
  const peak = Math.max(...used);
  const growth = used[used.length - 1] - used[0];
  return { 'mem.peakMB': round(peak), 'mem.growthMB': round(growth) };
}

/** The GPU feature status, flattened into the contract's `gpu.compositing`. */
export function gpuMetrics(gpuStatus) {
  if (!gpuStatus || typeof gpuStatus !== 'object') {
    return { 'gpu.compositing': null, 'gpu.status': null };
  }
  const webgl = gpuStatus.webgl ?? null;
  const webgl2 = gpuStatus.webgl2 ?? null;
  const compositing =
    gpuStatus.compositing ?? gpuStatus.rasterization ?? gpuStatus.gpu_compositing ?? null;
  return {
    'gpu.compositing': compositing === null ? null : String(compositing),
    'gpu.webgl': webgl === null ? null : String(webgl),
    'gpu.webgl2': webgl2 === null ? null : String(webgl2),
  };
}

/** Switch the sidebar to its Work tab, where the session list lives. */
export async function showWorkTab(page) {
  const workTab = page.getByTestId('sidebar-tab-work');
  await workTab.waitFor({ state: 'visible', timeout: 30_000 });
  const selected = await workTab.getAttribute('aria-selected');
  if (selected !== 'true') await workTab.click();
  await workTab.waitFor({ state: 'visible' });
}

/**
 * Click a session in the sidebar by its title.
 *
 * Returns a description of what was found, so a failure names the state the
 * sidebar was in instead of just timing out.
 */
export async function clickSidebarThread(page, title) {
  const selector = `div.thread-item[title="${title}"]`;
  const row = page.locator(selector).first();
  await row.waitFor({ state: 'visible', timeout: 30_000 });
  await row.click();
  return { clicked: title };
}

/** What the sidebar currently shows, for failure messages. */
export async function describeSidebar(page) {
  return page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('div.thread-item'));
    return {
      threadRows: items.length,
      titles: items.slice(0, 10).map((item) => item.getAttribute('title')),
      tabs: Array.from(document.querySelectorAll('[data-testid^="sidebar-tab-"]')).map(
        (tab) => tab.getAttribute('data-testid'),
      ),
    };
  });
}
