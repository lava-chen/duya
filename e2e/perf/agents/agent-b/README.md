# Agent B — streaming render benchmark

Measures the **streaming render path** of the chat view: a reply that is still
growing while tool events keep arriving.

## Where the pieces live

| Piece | Path | Why there |
| --- | --- | --- |
| Harness app (real chat components) | `packages/ui/src/components/chat/__tests__/harness/` | Inside the package that owns the components. An `e2e/` file that imports a workspace package is a NEW `module-dependency` architecture violation (verified against `npm run architecture:check`), and `e2e/turn/loopback-anthropic.ts` records the same governance decision for the host side. |
| Driver (build, serve, drive, collect) | `e2e/perf/agents/agent-b/run-bench.mjs` | Orchestration only: no product import, so no boundary is crossed. |

The harness renders the production path — `ToolActionsGroup → TextRow →
MarkdownRenderer → react-markdown → CodeBlock → react-syntax-highlighter` —
and drives it through `streamingEventsToActions`, the SAME mapping the
product's `useStreamingActions` hook uses, so the actions array the renderer
sees has production shape (a fresh array and fresh tool objects per frame).

## Running it

```powershell
# one scenario, five samples, holding the shared measurement lock
node e2e/perf/agents/agent-b/run-bench.mjs --scenario perf/stream-long-reply --runs 5

# with a CPU profile (builds unminified so the profile can name functions)
node e2e/perf/agents/agent-b/run-bench.mjs --scenario perf/stream-long-reply --runs 1 --profile

# capture the final DOM for a visual-equality check
node e2e/perf/agents/agent-b/run-bench.mjs --scenario perf/stream-long-reply --runs 1 `
  --html-out docs-local/perf-streaming/after.html --screenshot docs-local/perf-streaming/after.png
```

Flags: `--scenario`, `--runs`, `--profile`, `--out`, `--screenshot`,
`--html-out`, `--no-build` (reuse the last build), `--no-lock` (development
only — never for a reported number), `--lock-script <path>`.

## The measurement lock

Five agents benchmark the same machine concurrently, so a number taken while
another agent builds is a measurement of contention, not of the code. The
driver therefore holds the shared lock for the whole build+measure window:

```
node E:\Projects\duya\.claude\perf-bench-lock.mjs acquire agentB-streaming
node E:\Projects\duya\.claude\perf-bench-lock.mjs release
```

The lock script lives outside the repository, so its path is resolved in this
order:

| Source | Example |
| --- | --- |
| `--lock-script <path>` | `--lock-script E:\Projects\duya\.claude\perf-bench-lock.mjs` |
| `DUYA_PERF_LOCK_SCRIPT` | `$env:DUYA_PERF_LOCK_SCRIPT = '<path>'` |
| `DUYA_PERF_BENCH_LOCK` | legacy alias for the variable above |
| repository-relative candidates | `<repo>/.claude/perf-bench-lock.mjs`, `<repo>/perf-bench-lock.mjs`, `<repo>/../perf-bench-lock.mjs`, `<repo>/../../perf-bench-lock.mjs` |

When none of them exists the run still happens: the driver prints a warning
that the numbers are 未持锁测量 (taken without the lock) and the report records
`lock.enabled = false` with the reason.

## Fixtures

Both fixtures are deterministic — same bytes on every run.

| Scenario id | Shape |
| --- | --- |
| `ui-harness/stream-long-reply` | One long reply (~5k chars: prose, a table, three fenced code blocks in ts/python/bash), streamed in 20-char chunks per animation frame. |
| `ui-harness/stream-tool-storm` | A short reply plus 40 `tool_use` / `tool_result` pairs, one tool every two frames. |

The fixture content lives in `packages/ui/src/components/chat/__tests__/harness/fixture.ts`.

### Why these ids are not `perf/*`

The `perf/*` ids are the fixture **contract** of the shared harness
(`e2e/perf/lib/fixtures.mjs`), and every number in a report names the fixture
it measured. `perf/stream-long-reply` in that contract is a **plain text**
reply of 2 000 chunks; the reply this driver renders carries three fenced
code blocks. The same id with two different contents would make every
cross-harness comparison meaningless, so the local evidence harness keeps its
own `ui-harness/` namespace.

Mapping from the labels the first round's archived evidence used (PR #385,
whose report files are named after the old label):

| Archived label | Current label | Content |
| --- | --- | --- |
| `perf/stream-long-reply` | `ui-harness/stream-long-reply` | unchanged (fenced reply, 20-char chunks) |
| `perf/stream-tool-storm` | `ui-harness/stream-tool-storm` | unchanged (40 tool pairs) |

The shared harness's `perf/stream-long-reply` (plain text, 2 000 chunks) and
`perf/stream-tool-storm` (200 calls / 400 rows) were **not** renamed: they
are the contract the authoritative baseline was measured with, and changing
an id's content would change its digest.


## Metrics

| Metric | Source |
| --- | --- |
| `stream.block_ms_total` | CDP `Performance.getMetrics` → `TaskDuration` delta over the stream window (main-thread occupancy) |
| `stream.worstFreeze_ms` | `PerformanceObserver('longtask')` → longest task |
| `frame.p95_ms` | p95 of adjacent `requestAnimationFrame` intervals |
| `commit.count` | **Proxy**: MutationObserver change-batch count. A production build has no React Profiler, so this counts DOM-changing commits, not React commits. |
| `dom.mutations` | MutationObserver `childList` records |

`dom.nodes` is the live DOM size at the end of the stream.

## Reports

JSON reports land in `docs-local/perf-streaming/` (gitignored). The committed
numbers for this branch are in the PR description.
