/**
 * e2e/perf/lib/collector.mjs — the public collector API.
 *
 * This module is the contract other agents' measurement scripts use. It is
 * deliberately small and side-effect free apart from the instrumentation it
 * installs:
 *
 *   installCollector(page, options)  inject the collector into the renderer
 *   readCollector(page)              read the current snapshot back
 *   resetCollector(page)             clear the counters between phases
 *   openCdp(page)                    attach a CDP session (memory / CPU)
 *   readHeapUsage(cdp)               renderer heap used / total, in MB
 *   readPerformanceMetrics(cdp)      CDP Performance counters
 *
 * The collector NEVER changes product behaviour. It observes.
 */
import { COLLECTOR_SOURCE } from './collector-source.mjs';

/**
 * Install the collector into a renderer.
 *
 * Two steps, in this order:
 *   1. an init script that publishes the options (the collector reads them
 *      from `window.__DUYA_PERF_OPTIONS__`, because a source string cannot
 *      close over anything);
 *   2. the collector itself.
 *
 * Both are init scripts, so they run at document start on the NEXT
 * navigation — which is why the caller reloads after installing. The
 * currently loaded document is instrumented too, so a scenario that does not
 * reload still gets data (with the caveat that the earliest boot work is not
 * covered; the report says which case applies).
 */
export async function installCollector(page, options = {}) {
  const payload = JSON.stringify({
    maxFrames: options.maxFrames ?? 60000,
    maxLongTasks: options.maxLongTasks ?? 20000,
    maxKeys: options.maxKeys ?? 20000,
    mutationObserver: options.mutationObserver !== false,
  });
  // The init scripts are the ones that reach the NEXT document. If the
  // Electron page refuses them, the in-page install below still works and
  // the long-task observer still sees the buffered entries — the report
  // states which of the two happened.
  let initScriptError = null;
  try {
    await page.addInitScript({ content: `window.__DUYA_PERF_OPTIONS__ = ${payload};` });
    await page.addInitScript({ content: COLLECTOR_SOURCE });
  } catch (error) {
    initScriptError = String(error?.message ?? error);
  }
  const inPage = await page
    .evaluate(COLLECTOR_SOURCE)
    .then(() => true)
    .catch(() => false);
  return {
    installed: inPage,
    initScriptError,
    options: JSON.parse(payload),
  };
}

/** Read the collector snapshot. Returns null when the collector is absent. */
export async function readCollector(page) {
  return page
    .evaluate(() => {
      const perf = window.__duyaPerf;
      if (!perf || typeof perf.snapshot !== 'function') return null;
      return perf.snapshot();
    })
    .catch(() => null);
}

/** Clear the collector counters, keeping the instrumentation installed. */
export async function resetCollector(page) {
  return page
    .evaluate(() => {
      const perf = window.__duyaPerf;
      if (!perf || typeof perf.reset !== 'function') return false;
      perf.reset();
      return true;
    })
    .catch(() => false);
}

/**
 * Attach a CDP session to the renderer.
 *
 * Electron renderers are Chromium, so the DevTools protocol is available.
 * Returns null when the session cannot be created — the caller then reports
 * the memory / CPU numbers as unavailable instead of inventing them.
 */
export async function openCdp(page) {
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable').catch(() => undefined);
    return cdp;
  } catch {
    return null;
  }
}

/** Renderer heap usage in MB. Returns null when CDP is unavailable. */
export async function readHeapUsage(cdp) {
  if (!cdp) return null;
  try {
    const result = await cdp.send('Runtime.getHeapUsage');
    return {
      usedMB: result.usedSize / (1024 * 1024),
      totalMB: result.totalSize / (1024 * 1024),
    };
  } catch {
    return null;
  }
}

/**
 * CDP Performance counters, flattened to the fields the metric contract
 * needs. `taskDurationS` is cumulative since the counter was enabled, so a
 * caller samples it twice and divides by the elapsed wall time to get the
 * renderer's busy fraction.
 */
export async function readPerformanceMetrics(cdp) {
  if (!cdp) return null;
  try {
    const result = await cdp.send('Performance.getMetrics');
    const byName = new Map(result.metrics.map((metric) => [metric.name, metric.value]));
    const pick = (name) => (byName.has(name) ? byName.get(name) : null);
    return {
      taskDurationS: pick('TaskDuration'),
      scriptDurationS: pick('ScriptDuration'),
      layoutDurationS: pick('LayoutDuration'),
      recalcStyleDurationS: pick('RecalcStyleDuration'),
      nodes: pick('Nodes'),
      documents: pick('Documents'),
      jsHeapUsedMB:
        pick('JSHeapUsedSize') === null ? null : pick('JSHeapUsedSize') / (1024 * 1024),
      jsHeapTotalMB:
        pick('JSHeapTotalSize') === null ? null : pick('JSHeapTotalSize') / (1024 * 1024),
    };
  } catch {
    return null;
  }
}
