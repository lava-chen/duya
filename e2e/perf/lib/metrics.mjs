/**
 * e2e/perf/lib/metrics.mjs — aggregation helpers for the metric contract.
 *
 * The contract fixes the NAME and the UNIT of every metric; these helpers
 * only decide how a set of samples is summarised. There are deliberately no
 * thresholds here: the report presents numbers and trends, and the stability
 * classification exists so a reader can tell which numbers would survive a
 * CI regression gate and which would only produce noise.
 */

/** Linear-interpolated percentile. `p` is a fraction in [0, 1]. */
export function percentile(values, p) {
  const sorted = [...values].filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (sorted.length - 1) * p;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

/** The summary every metric gets in the report. */
export function summarize(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length === 0) {
    return { count: 0, min: null, max: null, mean: null, p50: null, p95: null, spreadPct: null };
  }
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const mean = clean.reduce((sum, value) => sum + value, 0) / clean.length;
  const p50 = percentile(clean, 0.5);
  const p95 = percentile(clean, 0.95);
  return {
    count: clean.length,
    min: round(min),
    max: round(max),
    mean: round(mean),
    p50: round(p50),
    p95: round(p95),
    spreadPct: p50 === 0 ? null : round(((max - min) / p50) * 100),
  };
}

/**
 * The noise classification of a metric across samples.
 *
 * `cv` is the coefficient of variation (stdev / mean), expressed as a
 * percentage. The levels are deliberately conservative: a metric with a CV
 * under 10% is a candidate for a CI regression gate, 10-25% is usable as a
 * trend indicator, and above that the noise drowns the signal.
 */
export function stability(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length < 2) {
    return { cv: null, level: 'unknown', samples: clean.length };
  }
  const mean = clean.reduce((sum, value) => sum + value, 0) / clean.length;
  if (mean === 0) return { cv: null, level: 'unknown', samples: clean.length };
  const variance = clean.reduce((sum, value) => sum + (value - mean) ** 2, 0) / clean.length;
  const cv = (Math.sqrt(variance) / Math.abs(mean)) * 100;
  const level = cv < 10 ? 'low' : cv < 25 ? 'medium' : 'high';
  return { cv: round(cv), level, samples: clean.length };
}

/** The gaps between consecutive rAF timestamps — the frame intervals. */
export function frameIntervals(frames) {
  const intervals = [];
  for (let i = 1; i < frames.length; i += 1) {
    const delta = frames[i] - frames[i - 1];
    // A gap larger than 2s is a backgrounded tab or a debugger pause, not a
    // frame; keeping it would make every percentile meaningless.
    if (delta > 0 && delta < 2000) intervals.push(delta);
  }
  return intervals;
}

/** Round to a stable number of decimals so two runs print the same shape. */
export function round(value, decimals = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Sum of a list, ignoring non-finite entries. */
export function sum(values) {
  return values
    .filter((value) => Number.isFinite(value))
    .reduce((total, value) => total + value, 0);
}
