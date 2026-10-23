/**
 * e2e/perf/lib/report.mjs — the report writers.
 *
 * Two outputs per run:
 *   <name>.json   machine readable, one record per scenario and sample
 *   <name>.md     the human summary a reviewer reads
 *
 * The report presents NUMBERS AND TRENDS. It never states a pass/fail
 * threshold: nothing in this harness is calibrated well enough for a hard
 * gate, and a threshold that is not calibrated is a lie that blocks merges.
 * The one judgement the report does make is the stability classification
 * (which metrics are quiet enough to become CI gates later), and it is
 * stated as a measured noise level rather than as a verdict.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stability, summarize } from './metrics.mjs';

export const REPORT_SCHEMA_VERSION = 1;

/** Assemble the machine-readable report. */
export function buildReport(input) {
  const results = (input.results ?? []).map((result) => {
    const metrics = new Map();
    for (const sample of result.samples ?? []) {
      for (const [name, value] of Object.entries(sample.metrics ?? {})) {
        if (!metrics.has(name)) metrics.set(name, []);
        if (Number.isFinite(value)) metrics.get(name).push(value);
      }
    }
    const summary = {};
    const stabilityByMetric = {};
    for (const [name, values] of metrics.entries()) {
      summary[name] = summarize(values);
      stabilityByMetric[name] = stability(values);
    }
    return {
      scenario: result.scenario,
      title: result.title ?? result.scenario,
      fixture: result.fixture ?? null,
      fixtureDigest: result.fixtureDigest ?? null,
      status: result.status ?? 'ok',
      error: result.error ?? null,
      samples: result.samples ?? [],
      summary,
      stability: stabilityByMetric,
      notes: result.notes ?? {},
    };
  });

  const ciCandidates = [];
  for (const result of results) {
    for (const [metric, info] of Object.entries(result.stability ?? {})) {
      const summary = result.summary?.[metric];
      // A constant metric has no variance at all, so its coefficient of
      // variation is 0 — that is not a low-noise signal, it is a constant
      // (a fixture size, a count). Only metrics that actually move are
      // candidates.
      if (summary && summary.min === summary.max) continue;
      if (info.level === 'low' && info.cv !== null) {
        ciCandidates.push({
          scenario: result.scenario,
          metric,
          cvPct: info.cv,
          samples: info.samples,
        });
      }
    }
  }
  ciCandidates.sort((a, b) => a.cvPct - b.cvPct);

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    harness: {
      name: 'duya-desktop-perf',
      version: input.harnessVersion ?? '1.0.0',
      contract: 'docs/exec-plans/active/2026-10-23-desktop-performance-hill-climbing.md',
    },
    generatedAt: new Date().toISOString(),
    environment: input.environment ?? {},
    run: {
      startedAt: input.startedAt ?? null,
      finishedAt: new Date().toISOString(),
      durationMs: input.durationMs ?? null,
      samplesPerScenario: input.samplesPerScenario ?? null,
      scenarios: results.map((result) => ({
        scenario: result.scenario,
        fixture: result.fixture,
        status: result.status,
        samples: (result.samples ?? []).length,
      })),
      lock: input.lock ?? { enabled: false, held: false, reason: 'not recorded' },
    },
    results,
    ciCandidates,
    notes: input.notes ?? {},
  };
}

function formatNumber(value) {
  if (value === null || value === undefined) return '-';
  if (typeof value !== 'number') return String(value);
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
}

/** The human-readable summary. */
export function renderMarkdown(report) {
  const lines = [];
  const env = report.environment ?? {};

  lines.push('# Duya Desktop performance report');
  lines.push('');
  lines.push(`- generated: \`${report.generatedAt}\``);
  lines.push(`- harness: \`${report.harness.name}\` v${report.harness.version}`);
  lines.push(`- build type: \`${env.buildType ?? 'production'}\``);
  lines.push(
    `- machine: ${env.cpuModel ?? 'unknown'} (${env.cpuCount ?? '?'} cores, `
      + `${env.totalMemoryMB ?? '?'} MB RAM)`,
  );
  lines.push(
    `- os: ${env.os ?? 'unknown'} · node: ${env.nodeVersion ?? 'unknown'} · `
      + `electron: ${env.electronVersion ?? 'unknown'} · chromium: ${env.chromiumVersion ?? 'unknown'}`,
  );
  lines.push(`- checkout: \`${env.gitSha ?? 'unknown'}\` (${env.gitBranch ?? '?'})`);
  lines.push(`- renderer: \`${env.rendererUrl ?? 'unknown'}\``);
  lines.push(
    `- measurement lock: ${
      report.run?.lock?.held
        ? `held by \`${report.run.lock.agent}\` during the measurement`
        : `NOT held (${report.run?.lock?.reason ?? 'unknown'})`
    }`,
  );
  lines.push(
    `- lock implementation: \`${report.run?.lock?.implementation ?? 'unknown'}\``
    + ` · dir: \`${report.run?.lock?.dir ?? 'unknown'}\``
    + ` · mode: \`${report.run?.lock?.mode ?? 'unknown'}\``,
  );
  lines.push(`- samples per scenario: ${report.run?.samplesPerScenario ?? '?'}`);
  lines.push('');

  lines.push('## Scenarios');
  lines.push('');
  lines.push('| scenario | fixture | fixture digest | status | samples |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const result of report.results ?? []) {
    lines.push(
      `| \`${result.scenario}\` | \`${result.fixture ?? '-'}\` | `
        + `\`${result.fixtureDigest ?? '-'}\` | ${result.status} | `
        + `${(result.samples ?? []).length} |`,
    );
  }
  lines.push('');

  for (const result of report.results ?? []) {
    lines.push(`## \`${result.scenario}\` — ${result.title ?? ''}`);
    lines.push('');
    lines.push(`- fixture: \`${result.fixture ?? '-'}\` (digest \`${result.fixtureDigest ?? '-'}\`)`);
    lines.push(`- status: ${result.status}${result.error ? ` — ${result.error}` : ''}`);
    if (result.notes && Object.keys(result.notes).length > 0) {
      for (const [key, value] of Object.entries(result.notes)) {
        lines.push(`- ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
      }
    }
    lines.push('');
    const metricNames = Object.keys(result.summary ?? {});
    if (metricNames.length === 0) {
      lines.push('_no metrics collected_');
      lines.push('');
      continue;
    }
    lines.push('| metric | unit | p50 | p95 | min | max | spread% | noise (cv%) |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const name of metricNames) {
      const summary = result.summary[name];
      const noise = result.stability?.[name];
      if (!summary) {
        lines.push(`| \`${name}\` | - | - | - | - | - | - | ${noise?.level ?? '-'} |`);
        continue;
      }
      lines.push(
        `| \`${name}\` | ${unitFor(name)} | ${formatNumber(summary.p50)} | `
          + `${formatNumber(summary.p95)} | ${formatNumber(summary.min)} | `
          + `${formatNumber(summary.max)} | ${formatNumber(summary.spreadPct)} | `
          + `${noise?.level ?? '-'} (${formatNumber(noise?.cv)}) |`,
      );
    }
    lines.push('');
  }

  lines.push('## Noise levels and CI candidates');
  lines.push('');
  lines.push(
    'A metric is a CI candidate only when its coefficient of variation across '
      + 'samples stays low enough that a regression would show up above the noise.',
  );
  lines.push('');
  if ((report.ciCandidates ?? []).length === 0) {
    lines.push('_no metric reached the low-noise band in this run_');
  } else {
    lines.push('| metric | scenario | cv% | samples |');
    lines.push('| --- | --- | --- | --- |');
    for (const candidate of report.ciCandidates) {
      lines.push(
        `| \`${candidate.metric}\` | \`${candidate.scenario}\` | `
          + `${formatNumber(candidate.cvPct)} | ${candidate.samples} |`,
      );
    }
  }
  lines.push('');
  lines.push('## Per-sample values');
  lines.push('');
  for (const result of report.results ?? []) {
    lines.push(`### \`${result.scenario}\``);
    lines.push('');
    const samples = result.samples ?? [];
    if (samples.length === 0) {
      lines.push('_no samples_');
      lines.push('');
      continue;
    }
    const metricNames = [...new Set(samples.flatMap((sample) => Object.keys(sample.metrics ?? {})))];
    lines.push(`| sample | ${metricNames.join(' | ')} |`);
    lines.push(`| --- | ${metricNames.map(() => '---').join(' | ')} |`);
    for (const sample of samples) {
      lines.push(
        `| ${sample.index} | ${metricNames
          .map((name) => formatNumber(sample.metrics?.[name]))
          .join(' | ')} |`,
      );
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function unitFor(metricName) {
  if (metricName.endsWith('_ms')) return 'ms';
  if (metricName.endsWith('_MB')) return 'MB';
  if (metricName.endsWith('_pct')) return '%';
  if (metricName.endsWith('.count')) return 'count';
  if (metricName.endsWith('.nodes')) return 'nodes';
  return '-';
}

/** Write both report files. Returns their paths. */
export async function writeReport({ dir, basename, report }) {
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, `${basename}.json`);
  const mdPath = path.join(dir, `${basename}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, renderMarkdown(report), 'utf8');
  return { jsonPath, mdPath };
}
