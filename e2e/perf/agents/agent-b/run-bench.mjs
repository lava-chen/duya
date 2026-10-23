#!/usr/bin/env node
/**
 * Agent B — streaming render benchmark driver.
 *
 * WHAT IT MEASURES
 *
 * The streaming render path of the chat view: a reply that is still growing
 * while tool events keep arriving. The harness app (the real chat components,
 * driven by the real `streamingEventsToActions` mapping) lives in
 * `packages/ui/src/components/chat/__tests__/harness/` — inside the package
 * that owns the components, because an `e2e/` file that imports a workspace
 * package is a NEW architecture violation (see the harness header).
 *
 * This driver only orchestrates: build the harness (production React),
 * serve it, drive a real Chromium, collect the numbers, write the report.
 *
 * METRICS (project perf contract)
 *
 *   stream.block_ms_total   main-thread occupancy during the stream window
 *                           (CDP Performance TaskDuration delta)
 *   stream.worstFreeze_ms   longest single Long Task
 *   frame.p95_ms            p95 of adjacent requestAnimationFrame intervals
 *   commit.count            React commit count — PROXY: production builds have
 *                           no React Profiler, so this is the sanctioned
 *                           MutationObserver change-batch count
 *   dom.mutations           childList mutation records
 *
 * USAGE
 *
 *   node e2e/perf/agents/agent-b/run-bench.mjs --scenario perf/stream-long-reply --runs 5
 *   node e2e/perf/agents/agent-b/run-bench.mjs --scenario perf/stream-tool-storm --runs 5 --profile
 *
 * The run holds the shared measurement lock (`.claude/perf-bench-lock.mjs`)
 * for the whole build+measure window, so the numbers are not a measurement of
 * another agent's build. Override the lock script with
 * DUYA_PERF_BENCH_LOCK=<path>.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');
const HARNESS_DIR = path.join(REPO_ROOT, 'packages/ui/src/components/chat/__tests__/harness');
const HARNESS_VITE_CONFIG = path.join(HARNESS_DIR, 'vite.config.ts');
const DIST_DIR = path.join(REPO_ROOT, 'docs-local/perf-streaming/harness-dist');
const LOCK_SCRIPT = process.env.DUYA_PERF_BENCH_LOCK ?? 'E:/Projects/duya/.claude/perf-bench-lock.mjs';
const LOCK_AGENT = 'agentB-streaming';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function parseArgs(argv) {
  const args = { scenario: 'perf/stream-long-reply', runs: 5, profile: false, lock: true, build: true, out: null, screenshot: null, htmlOut: null, dist: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--scenario') args.scenario = argv[++i];
    else if (arg === '--runs') args.runs = Number(argv[++i]);
    else if (arg === '--profile') args.profile = true;
    else if (arg === '--no-lock') args.lock = false;
    else if (arg === '--no-build') args.build = false;
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--screenshot') args.screenshot = argv[++i];
    else if (arg === '--html-out') args.htmlOut = argv[++i];
    else if (arg === '--dist') args.dist = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function lock(action) {
  const result = spawnSync(process.execPath, [LOCK_SCRIPT, action, action === 'acquire' ? LOCK_AGENT : ''], {
    encoding: 'utf8',
  });
  process.stdout.write(result.stdout ?? '');
  if (result.status !== 0) {
    throw new Error(`perf bench lock ${action} failed with status ${result.status}`);
  }
}

function buildHarness({ unminified = false } = {}) {
  const viteBin = path.join(REPO_ROOT, 'node_modules/vite/bin/vite.js');
  const env = { ...process.env };
  if (unminified) env.PERF_HARNESS_UNMINIFIED = '1';
  else delete env.PERF_HARNESS_UNMINIFIED;
  const result = spawnSync(process.execPath, [viteBin, 'build', '--config', HARNESS_VITE_CONFIG], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error(`harness build failed with status ${result.status}`);
  }
  process.stdout.write(`[bench] harness built -> ${path.relative(REPO_ROOT, DIST_DIR)}\n`);
}

function startServer(rootDir) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(rootDir, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!file.startsWith(rootDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[index];
}

/** Self time per function, from a CDP CPU profile. */
function aggregateProfile(profile) {
  const nodesById = new Map(profile.nodes.map((node) => [node.id, node]));
  const selfByKey = new Map();
  profile.samples.forEach((nodeId, index) => {
    const node = nodesById.get(nodeId);
    if (!node) return;
    const delta = profile.timeDeltas?.[index] ?? 0;
    const frame = node.callFrame;
    const url = (frame.url ?? '').split('/').pop() ?? '';
    const key = `${frame.functionName || '(anonymous)'} @ ${url}:${frame.lineNumber + 1}`;
    selfByKey.set(key, (selfByKey.get(key) ?? 0) + delta);
  });
  const total = [...selfByKey.values()].reduce((sum, value) => sum + value, 0);
  return {
    totalUs: total,
    top: [...selfByKey.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([key, us]) => ({
        fn: key,
        selfMs: Number((us / 1000).toFixed(1)),
        pct: Number(((us / (total || 1)) * 100).toFixed(1)),
      })),
  };
}

async function measureOnce(browser, port, args) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error?.stack ?? error)));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`console.error: ${message.text()}`);
  });

  await page.goto(`http://127.0.0.1:${port}/index.html?scenario=${encodeURIComponent(args.scenario)}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => typeof window.__benchReset === 'function', null, { timeout: 30_000 });

  await cdp.send('Performance.enable');
  const before = await cdp.send('Performance.getMetrics');
  const beforeMap = new Map(before.metrics.map((metric) => [metric.name, metric.value]));

  if (args.profile) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
    await cdp.send('Profiler.start');
  }

  await page.evaluate(() => {
    window.__benchStart = true;
  });
  try {
    await page.waitForFunction(() => window.__benchDone === true, null, { timeout: 120_000 });
  } catch (error) {
    const state = await page.evaluate(() => ({
      done: window.__benchDone ?? null,
      start: window.__benchStart ?? null,
      frames: typeof window.__benchMetrics === 'function' ? window.__benchMetrics().frames : null,
      body: document.body?.innerText?.slice(0, 200) ?? '',
      nodes: document.getElementsByTagName('*').length,
    }));
    throw new Error(
      `stream did not finish: ${JSON.stringify(state)}\npage errors:\n${pageErrors.join('\n---\n') || '(none)'}`,
    );
  }

  let profileSummary = null;
  if (args.profile) {
    const { profile } = await cdp.send('Profiler.stop');
    profileSummary = aggregateProfile(profile);
  }

  const after = await cdp.send('Performance.getMetrics');
  const afterMap = new Map(after.metrics.map((metric) => [metric.name, metric.value]));

  const metrics = await page.evaluate(() => window.__benchMetrics());
  // The adaptive typewriter keeps pacing the tail of the reply after the last
  // token arrived, so the DOM at the instant the stream ends is not the final
  // DOM: two runs would differ in how many characters they had typed out.
  // Wait for the tail to settle BEFORE capturing the DOM, so a before/after
  // comparison compares the same rendered result.
  await page.waitForTimeout(1500);
  if (args.screenshot) {
    await page.screenshot({ path: args.screenshot, fullPage: false });
  }
  if (args.htmlOut) {
    const html = await page.evaluate(() => document.getElementById('stream')?.innerHTML ?? '');
    fs.mkdirSync(path.dirname(args.htmlOut), { recursive: true });
    fs.writeFileSync(args.htmlOut, html, 'utf8');
  }

  await context.close();

  const taskDurationMs = ((afterMap.get('TaskDuration') ?? 0) - (beforeMap.get('TaskDuration') ?? 0)) * 1000;
  const scriptDurationMs = ((afterMap.get('ScriptDuration') ?? 0) - (beforeMap.get('ScriptDuration') ?? 0)) * 1000;
  const layoutCount = (afterMap.get('LayoutCount') ?? 0) - (beforeMap.get('LayoutCount') ?? 0);
  const layoutDurationMs = ((afterMap.get('LayoutDuration') ?? 0) - (beforeMap.get('LayoutDuration') ?? 0)) * 1000;
  const recalcStyleCount = (afterMap.get('RecalcStyleCount') ?? 0) - (beforeMap.get('RecalcStyleCount') ?? 0);
  const recalcStyleDurationMs =
    ((afterMap.get('RecalcStyleDuration') ?? 0) - (beforeMap.get('RecalcStyleDuration') ?? 0)) * 1000;

  return {
    taskDurationMs: Number(taskDurationMs.toFixed(1)),
    scriptDurationMs: Number(scriptDurationMs.toFixed(1)),
    pageErrors,
    layoutCount,
    layoutDurationMs: Number(layoutDurationMs.toFixed(1)),
    recalcStyleCount,
    recalcStyleDurationMs: Number(recalcStyleDurationMs.toFixed(1)),
    longTaskCount: metrics.longTaskCount,
    longTaskTotalMs: Number(metrics.longTaskTotalMs.toFixed(1)),
    longTaskMaxMs: Number(metrics.longTaskMaxMs.toFixed(1)),
    frameP95Ms: metrics.frameP95Ms,
    frameMaxMs: metrics.frameMaxMs,
    frames: metrics.frames,
    commitCount: metrics.mutations.totalBatches,
    domMutations: metrics.mutations.totalRecords,
    mutationsByRegion: metrics.mutations,
    domNodes: metrics.domNodes,
    durationMs: Number(metrics.durationMs.toFixed(1)),
    historyRenders: metrics.renderCounts?.history ?? 0,
    profile: profileSummary,
  };
}

function summarize(runs) {
  const keys = [
    'taskDurationMs',
    'scriptDurationMs',
    'longTaskTotalMs',
    'longTaskMaxMs',
    'frameP95Ms',
    'frameMaxMs',
    'commitCount',
    'domMutations',
    'layoutCount',
    'recalcStyleCount',
    'domNodes',
    'durationMs',
  ];
  const summary = {};
  for (const key of keys) {
    const values = runs.map((run) => run[key]);
    summary[key] = {
      median: percentile(values, 0.5),
      min: Math.min(...values),
      max: Math.max(...values),
      values,
    };
  }
  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.lock) lock('acquire');
  try {
    if (args.build) buildHarness({ unminified: args.profile });
    // `--dist` serves an ALREADY BUILT harness. It exists so a before/after
    // comparison can interleave the two builds inside ONE measurement window:
    // five agents share this machine, so a "before" measured minutes before
    // an "after" measures the machine's load as much as the code.
    const distDir = args.dist ? path.resolve(REPO_ROOT, args.dist) : DIST_DIR;
    if (!fs.existsSync(path.join(distDir, 'index.html'))) {
      throw new Error(`harness build output missing: ${path.join(distDir, 'index.html')}`);
    }

    const { server, port } = await startServer(distDir);
    const browser = await chromium.launch({ args: ['--disable-gpu-vsync'] });
    const runs = [];
    try {
      for (let index = 0; index < args.runs; index += 1) {
        const run = await measureOnce(browser, port, args);
        runs.push(run);
        process.stdout.write(
          `[bench] run ${index + 1}/${args.runs}: task=${run.taskDurationMs}ms ` +
            `longtask=${run.longTaskTotalMs}ms/${run.longTaskCount} frameP95=${run.frameP95Ms}ms ` +
            `commits=${run.commitCount} mutations=${run.domMutations}\n`,
        );
      }
    } finally {
      await browser.close();
      server.close();
    }

    const report = {
      fixture: args.scenario,
      agent: LOCK_AGENT,
      generatedAt: new Date().toISOString(),
      environment: {
        cpu: process.env.PROCESSOR_IDENTIFIER ?? 'unknown',
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        buildType: 'production (vite build, minified, production react)',
        browser: 'chromium (playwright)',
      },
      runs: runs.length,
      summary: summarize(runs),
      details: runs,
    };
    const outPath = args.out ?? path.join(REPO_ROOT, 'docs-local/perf-streaming', `${args.scenario.replace(/[^a-z0-9]+/gi, '-')}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`[bench] report -> ${outPath}\n`);
    for (const [key, value] of Object.entries(report.summary)) {
      process.stdout.write(`[bench] ${key}: median=${value.median} min=${value.min} max=${value.max}\n`);
    }
  } finally {
    if (args.lock) lock('release');
  }
}

main().catch((error) => {
  process.stderr.write(`[bench] failed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
