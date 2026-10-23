/**
 * e2e/perf/lib/scenario-kit.mjs — the shared measurement plumbing.
 *
 * Every scenario measures the same way: reset the collector, let the product
 * do the work, read the collector back, and turn the observation into the
 * metric names of the contract. The naming and the unit are fixed here so
 * two agents measuring different journeys still produce comparable numbers.
 */
import { frameIntervals, percentile, round, sum } from './metrics.mjs';
import {
  openCdp,
  readCollector,
  readHeapUsage,
  readPerformanceMetrics,
  resetCollector,
} from './collector.mjs';

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
  const rendererPct = rendererBusyPct(before, after, elapsedMs);
  return {
    heapBefore,
    heapAfter,
    perfBefore: before,
    perfAfter: after,
    rendererPct,
    elapsedMs,
  };
}

/**
 * The renderer's busy fraction over a window, in percent.
 *
 * The CDP TaskDuration counter is cumulative, so the delta is divided by the
 * elapsed wall time. `null` when the counter is unavailable — an unavailable
 * number is reported as unavailable, never as zero.
 */
export function rendererBusyPct(before, after, elapsedMs) {
  const taskDelta =
    before?.taskDurationS !== null && before?.taskDurationS !== undefined
      && after?.taskDurationS !== null && after?.taskDurationS !== undefined
      ? after.taskDurationS - before.taskDurationS
      : null;
  if (taskDelta === null || elapsedMs <= 0) return null;
  return round((taskDelta / (elapsedMs / 1000)) * 100);
}

/**
 * A running probe of the renderer-side CPU and memory.
 *
 * The heap is sampled on an interval, so `mem.peakMB` is a real peak inside
 * the window and not just its two endpoints. `stop()` returns the contract's
 * resource metrics:
 *
 *   cpu.renderer_pct   the renderer's busy fraction during the window
 *   mem.peakMB         the highest heap reading observed
 *   mem.growthMB       the last reading minus the first one
 *
 * The probe never changes product behaviour; it only reads counters.
 */
export async function startResourceProbe(page, options = {}) {
  const cdp = await openCdp(page);
  const heapReadings = [];
  const before = await readPerformanceMetrics(cdp);
  const startedAt = Date.now();
  const intervalMs = options.intervalMs ?? 1000;
  const timer = setInterval(() => {
    readHeapUsage(cdp)
      .then((reading) => {
        if (reading) heapReadings.push(reading);
      })
      .catch(() => undefined);
  }, intervalMs);
  // The probe must never keep the process alive: a scenario that fails before
  // it stops the probe still has to let the runner exit.
  timer.unref?.();
  let stopped = null;
  return {
    cdp,
    async stop() {
      if (stopped) return stopped;
      clearInterval(timer);
      const after = await readPerformanceMetrics(cdp);
      const last = await readHeapUsage(cdp);
      if (last) heapReadings.push(last);
      const elapsedMs = Date.now() - startedAt;
      stopped = {
        'cpu.renderer_pct': rendererBusyPct(before, after, elapsedMs),
        ...memoryMetrics(heapReadings),
        'mem.samples': heapReadings.length,
      };
      return stopped;
    },
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
  try {
    await workTab.waitFor({ state: 'visible', timeout: 30_000 });
    const selected = await workTab.getAttribute('aria-selected');
    if (selected !== 'true') await workTab.click();
    await workTab.waitFor({ state: 'visible' });
    return true;
  } catch {
    // The sidebar is not the only way in: the welcome view lists the recent
    // sessions too. The caller decides what to do with a missing sidebar.
    return false;
  }
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

/**
 * Open a seeded session the way a user does.
 *
 * Two product affordances open a session, and the harness uses whichever the
 * app shows:
 *   - the session row in the sidebar (`div.thread-item[title]`)
 *   - the welcome view's "recent threads" list (`button.recent-item`)
 *
 * The app is NOT asked to restore a session across a restart — in this build
 * the boot splash cannot resolve a session the worker does not know, so a
 * restored session never renders its transcript. Clicking a row is the
 * navigation the product supports.
 *
 * `lastMessageId` is the signal that the transcript is really on screen: the
 * message list always renders its trailing rows, so that row appearing is a
 * paint signal and not a store signal.
 */
export async function openSeededSession(page, options) {
  const { title, lastMessageId, timeoutMs = 60_000 } = options;
  await showWorkTab(page);
  const row = page.locator(`div.thread-item[title="${title}"]`).first();
  // The welcome view lists the recent sessions; the row carries the title
  // next to the project and the date.
  const recent = page.locator('.recent-item', { hasText: title }).first();

  const deadline = Date.now() + timeoutMs;
  let openedBy = null;
  while (Date.now() < deadline && openedBy === null) {
    if ((await row.count()) > 0 && (await row.isVisible().catch(() => false))) {
      await row.click();
      openedBy = 'sidebar';
      break;
    }
    if ((await recent.count()) > 0 && (await recent.isVisible().catch(() => false))) {
      await recent.click();
      openedBy = 'welcome-recent-list';
      break;
    }
    await page.waitForTimeout(500);
  }
  if (openedBy === null) {
    throw new Error(`the seeded session "${title}" is not reachable in the UI`);
  }
  if (!lastMessageId) return { opened: true, openedBy };
  await page.waitForFunction(
    (id) => Boolean(document.querySelector(`[data-message-id="${id}"]`)),
    lastMessageId,
    { timeout: timeoutMs, polling: 'raf' },
  );
  return { opened: true, openedBy, lastMessageId };
}
