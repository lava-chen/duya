/**
 * e2e/perf/lib/startup-phases.mjs — the boot split into the phases that own it.
 *
 * WHY THIS EXISTS
 *
 * `startup.firstPaint_ms` is one number for a boot that has at least three
 * owners: the browser process start, the main process' own startup chain,
 * the renderer's cold initialization, and the first screen's JavaScript.
 * A single number cannot say which of them to attack, and every attempt to
 * find out by reading the code has been wrong (the round-7 and round-8
 * measurements each overturned the reading).
 *
 * So the harness measures the split, on the renderer's own clock
 * (`performance.timeOrigin`), and the phases are named after what they wait
 * for:
 *
 *   navToHtml   navigation start -> the HTML document arrived
 *   htmlToDcl   the HTML arrived -> DOMContentLoaded
 *               (the first screen's JavaScript: fetch, compile, execute)
 *   dclToPaint  DOMContentLoaded -> the first contentful paint
 *
 * The instrumented reload of the same boot path provides the warm
 * reference: the same phases on a renderer that is already up. The
 * difference between the cold and the warm numbers is the part of the boot
 * that is Chromium's cold path, not the app's.
 *
 * `startupPhases` is a pure function so the split can be unit tested
 * without launching Electron.
 */

/** Round to a stable number of decimals, matching the harness metric style. */
function round(value, decimals = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * The phase split of one document load.
 *
 * `navigation` is the Navigation Timing entry of the document
 * (`performance.getEntriesByType('navigation')[0]`) and `paints` maps the
 * paint entry names to their document-relative timestamps
 * (`first-contentful-paint`, `first-paint`).
 */
export function startupPhases(navigation, paints) {
  if (!navigation) {
    return {
      navToHtml_ms: null,
      htmlToDcl_ms: null,
      dclToPaint_ms: null,
      navToDcl_ms: null,
      navToPaint_ms: null,
    };
  }
  const responseEnd = navigation.responseEnd;
  const dcl = navigation.domContentLoadedEventEnd;
  const fcp = paints?.['first-contentful-paint'] ?? null;
  // A timing field that is still 0 means the milestone has not happened yet.
  // Reporting it as a number would turn "not measured" into "instant", and
  // the subtraction would even go negative.
  const htmlArrived = Number.isFinite(responseEnd) && responseEnd > 0;
  const dclFired = htmlArrived && Number.isFinite(dcl) && dcl > 0;
  return {
    navToHtml_ms: htmlArrived ? round(responseEnd) : null,
    htmlToDcl_ms: dclFired ? round(dcl - responseEnd) : null,
    dclToPaint_ms: dclFired && fcp !== null ? round(fcp - dcl) : null,
    navToDcl_ms: dclFired ? round(dcl) : null,
    navToPaint_ms: fcp === null ? null : round(fcp),
  };
}

/**
 * Read the phase split out of a live document.
 *
 * The Navigation Timing entry of a `file://` document exists (the renderer
 * reports one), but the RESOURCE entries do not: a file URL is not a
 * fetchable resource in the timing timeline. That is why the split is
 * anchored on the document's own milestones instead of on the module
 * requests.
 */
export async function readStartupPhases(page) {
  const raw = await page.evaluate(() => {
    const entry = performance.getEntriesByType('navigation')[0] ?? null;
    const paints = Object.fromEntries(
      performance.getEntriesByType('paint').map((paint) => [paint.name, paint.startTime]),
    );
    return {
      navigation: entry
        ? {
            responseEnd: entry.responseEnd,
            domContentLoadedEventEnd: entry.domContentLoadedEventEnd,
          }
        : null,
      paints,
    };
  });
  return startupPhases(raw.navigation, raw.paints);
}

/** The phase metrics of one boot, under the given metric prefix. */
export function startupPhaseMetrics(prefix, phases) {
  return {
    [`${prefix}.phase.navToHtml_ms`]: phases.navToHtml_ms,
    [`${prefix}.phase.htmlToDcl_ms`]: phases.htmlToDcl_ms,
    [`${prefix}.phase.dclToPaint_ms`]: phases.dclToPaint_ms,
    [`${prefix}.phase.navToDcl_ms`]: phases.navToDcl_ms,
    [`${prefix}.phase.navToPaint_ms`]: phases.navToPaint_ms,
  };
}
