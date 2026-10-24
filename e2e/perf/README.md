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

**An id names one content.** A report is only comparable to another report
when both name the same fixture id AND that id resolves to the same bytes.
A harness that renders different content under a `perf/*` id must use its own
namespace instead — the local evidence harness under `e2e/perf/agents/agent-b/`
uses `ui-harness/*` for exactly that reason (see its README). Changing the
content of an existing id is not allowed: it changes the digest and silently
invalidates every archived number that used it.

**Seed the same fixture into two sessions? Give the rows different ids.**
The transcript store appends with `INSERT OR IGNORE` on the message id, so
two sessions carrying the same ids leave the second one empty:

```js
buildSessionMessages('perf/session-100', { idPrefix: sessionId })
```

The digest is over the canonical (un-namespaced) payload, so it does not
change with the namespace.

## How the scenarios drive the app

**Prepare the profile, then measure an untouched boot.** The prepare launch
seeds the sessions through the product's own IPC (`electronAPI.thread.create`
+ `electronAPI.message.replace`) and then lets the app sync itself
(`wakeConversationStore`). The app therefore writes its own persisted store
state, and the MEASURED launch is a plain product launch: it hydrates, lists
the sessions and enables the composer on its own. The harness never writes
the app's persisted state by hand.

The seeded session is opened by CLICKING its row in the sidebar
(`div.thread-item[title]`), and "the transcript is on screen" is the last
fixture row appearing in the DOM. The harness does not restore a session
across a restart: in this build the boot splash cannot resolve a session the
worker does not know (it stays on "Preparing session…"), so a restored
session never renders its transcript. Opening the session is the navigation
the product supports.

`startup.typeable_ms` waits for the composer to be editable AND the boot
splash (`.duya-startup-landing`) to be gone — the welcome view is rendered
behind that overlay, and its composer is editable while it is up.

### The cold and the warm boot

`startup.firstPaint_ms` is the **cold** boot (a profile the user has never
seen); `startup.typeable_ms` is the **warm** boot (a profile the app can
hydrate — a returning user). `startup.cold.*` and `startup.warm.*` carry both
in full. The cold boot's composer is disabled on a profile with no project,
so `startup.cold.typeable_ms` is null and the evidence is in the sample.

### The hydration defect this harness works around

**This defect is fixed** (PR #400): the normalization now runs inside the
`merge` that zustand's persist middleware performs, so `isHydrated` is
published with that single write and the subscribers are notified. The
workaround below is therefore no longer required for the measured boot — but
the harness still performs it, because the prepare phase needs a profile the
app can hydrate, and the sync nudge is how that profile is built.

For the record, the defect was this: `packages/ui/src/stores/conversation-store.ts`
marked itself hydrated in `onRehydrateStorage` by MUTATING the state
(`s.isHydrated = true`). Zustand v5 does not notify subscribers after that
callback, so on a profile whose persisted store state was absent the mutation
was never observed: `isHydrated` stayed false in React, `app-sidebar.tsx`
never called `loadFromDatabase()`, the session list stayed empty and the
welcome composer stayed disabled (`WelcomeView.tsx`:
`disabled={!isHydrated || !selectedProject}`).

The harness works around it by letting the app sync itself in the prepare
phase (`sync:threads-changed` → `forceSync()` → `loadFromDatabase()`, which
IS a `set()`).

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

Five agents share this machine, so every measured scenario takes a shared
lock. **The mutex lives in the repository** (`e2e/perf/lib/lock.mjs`): an
atomic `mkdir` is the lock, the owner is a JSON file inside it, and a lock
older than 30 minutes is stale and may be taken over.

The external script (`E:\Projects\duya\.claude\perf-bench-lock.mjs`, or any
path given by `--lock-script` / `DUYA_PERF_LOCK_SCRIPT`) is an optional
overrides. Its location decides where the SHARED lock lives, so an agent
that drives the script and an agent that uses the in-repo implementation
exclude each other instead of taking two different locks:

```
--lock-script <path>  →  DUYA_PERF_LOCK_SCRIPT  →  the in-repo implementation
lock dir: --lock-dir  →  DUYA_PERF_LOCK_DIR  →  <the external script's dir>/perf-bench.lock
                       →  <repo>/.claude/perf-bench.lock
```

The lock is taken PER SCENARIO, not for the whole run, so the agents can
rotate; the report records `run.lock.held` per scenario, so a reader can
tell whether the numbers were taken uncontended.
