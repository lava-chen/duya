# e2e/perf — the shared Desktop performance facility

Real Electron + production build. One command, one report.

```bash
node e2e/perf/run.mjs                      # all scenarios, 3 samples each
node scripts/perf/run.mjs --samples 1      # same, shorter
node e2e/perf/run.mjs --scenarios startup --no-lock
```

Reports land in `docs-local/research/perf-harness/` (gitignored) as
`<stamp>.json` + `<stamp>.md`.

## Why preview mode

`detectDevServerPort()` only probes 3000–3005, so a dev-server launch can
load **another worktree's** renderer. The harness always uses
`DUYA_PREVIEW_MODE=true` + `dist/` (production build) and a per-namespace
`--user-data-dir`. Required build: `npm run bundle:worker && npm run
build:electron && npx vite build`.

## The two modules other agents import

```js
import { installCollector, readCollector, readHeapUsage, readPerformanceMetrics }
  from '../perf/lib/collector.mjs';
import { buildSessionMessages, buildToolStormRows, buildStreamChunks,
         buildTypingFixture, fixtureDigest, FIXTURE_IDS }
  from '../perf/lib/fixtures.mjs';
```

`installCollector(page)` injects the collector (`page.addInitScript` +
in-page install). `readCollector(page)` returns the snapshot:
`frames`, `longTasks`, `mutationBatches`, `mutationRecords`, `keyLatencies`,
`domNodes`, `composerReadyAt`, `webglContextsLost`, `pageErrors`.

The collector NEVER changes product behaviour. `commit.count` is a
MutationObserver proxy for React commits (a production build has no Profiler);
the report says so.

## Fixture ids

| id | content |
| --- | --- |
| `perf/session-100` | 100 history messages |
| `perf/session-1000` | 1 000 history messages |
| `perf/session-10000` | 10 000 history messages |
| `perf/stream-long-reply` | one long reply, streamed token by token |
| `perf/stream-tool-storm` | 200 tool calls (400 rows) flowing in |
| `perf/typing-30s` | 30 s of typing, one keystroke per 60 ms |

A history fixture repeats a 10-row block: 40 % user text, 40 % assistant
text, 20 % tool rows (`tool_use` + its `tool_result`). The rows are shaped
like the flat IPC message DTO, so they can be injected through the real
bridge (`electronAPI.message.replace`). `fixtureDigest(id)` is the SHA-256 of
the canonical payload and is printed in every report.

## Metric names

Fixed by the plan: `startup.firstPaint_ms`, `startup.typeable_ms`,
`interact.p50_ms`, `interact.p95_ms`, `frame.p95_ms`, `longtask.count`,
`longtask.total_ms`, `stream.block_ms_total`, `stream.worstFreeze_ms`,
`commit.count`, `dom.nodes`, `dom.mutations`, `mem.peakMB`, `mem.growthMB`,
`cpu.renderer_pct`, `gpu.compositing`.

There are **no thresholds**. A report states numbers, their spread across
samples and the noise level (CV) of each metric; the metrics that stay in
the low-noise band are listed as CI candidates.

## The measurement lock

Five agents share this machine, so every run takes
`.claude/perf-bench-lock.mjs` (configurable via `--lock-script` /
`DUYA_PERF_LOCK_SCRIPT`). The report records `run.lock.held`, so a reviewer
can tell whether the numbers were taken uncontended.
