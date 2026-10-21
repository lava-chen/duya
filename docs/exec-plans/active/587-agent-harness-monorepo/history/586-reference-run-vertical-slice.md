> Historical / superseded for execution. 原位置：`docs/exec-plans/active/586-reference-run-vertical-slice.md`。
> 唯一执行入口：[587 主计划](../README.md)；设计冲突以 [00 合同](../00-contracts.md) 为准。旧 Status / checkbox / 行号保留为历史证据。

# 586 — Reference Run vertical slice (Control Plane → Runtime → RunEvent → SQLite)

> Status: **landed — awaiting Electron smoke** (P0–P5 + closed-loop evidence done; P6 runtime smoke needs a provider key)
> Owner: agent-harness
> Depends on: plan 584 PP-0/PP-1 (`@duya/agent-protocol`, landed), `MONOREPO_RFC.md`,
> `docs/architecture/03-target-structure.md` M5, `06-migration-plan.md` C1/M5
> Superset of: `06-migration-plan.md` M5.1 + M5.2 + RFC §9 step 6, taken as one
> vertical slice instead of four file-moving PRs.

---

## 0. What this plan delivers

One end-to-end **Reference Run**:

```
Control Plane                 Runtime                    Storage
─────────────                 ───────                    ───────
mint runId
build + freeze RunManifest
persist runs row        ──▶  RunController.start()
                              ledger mints run-scoped seq
                              drive worker `chat:start`
persist run.started    ◀──   run.started
                              translate chat:* → RunEvent
                              project RunEvent → legacy SSE  ──▶ renderer (UNCHANGED)
persist run_events     ◀──   durable events, batched
terminal CAS                   run.completed | run.failed
persist runs.status     ◀──
```

**Acceptance:** a user chat turn produces a `runs` row, a gapless
`run_events` log keyed `(run_id, seq)`, and a terminal `runs.status` — while
`apps/desktop/src/renderer/**` and `apps/desktop/src/preload/**` are byte-identical.

---

## 1. Why a vertical slice and not M5 as written

`06-migration-plan.md` M5.1/M5.2 move ~42k LOC out of `packages/agent` **after**
C1 unwinds 18 circular SCCs. That is a prerequisite chain nobody can validate
until it lands, and the first thing it would produce is a *compile-clean* tree
with no new capability: a boundary that exists and carries nothing.

The Reference Run forces the boundary to carry the whole loop instead. A package
that owns run identity, `seq`, and the event stream is the boundary; whether the
model loop inside it is `duyaAgent` today or a rewritten harness is an
implementation detail **behind** it. That inverts the risk: if the runtime turns
out to be wrong, we replace one package, not a 42-file move.

### Migrate or rewrite — the decision

**Migrate behind a new boundary. Do not rewrite the model loop.**

| Option | Verdict |
|---|---|
| C — physical move per M5 (after C1) | Blocked: the 42-file SCC straddles the cut. Would land a boundary carrying nothing. |
| B — rewrite the model loop protocol-native | Rejected for this slice: breaks 100+ renderer event names and the 520-test agent suite, and cannot close the loop in one change. |
| **A — new packages, existing agent as the execution backend** | **Chosen.** Real boundary, real closed loop, reversible. |

`packages/agent` stays as the execution backend. `packages/agent-runtime` owns
*run semantics*; `packages/agent` owns *the model loop*. RFC §3.4 already draws
that line.

---

## 2. Where each layer lives, and why

The chat path is **three processes**, which decides everything:

```
renderer ──HTTP+SSE──▶ agent-server (fork) ──stdio JSON──▶ agent worker (fork)
                            │                                    │
                            └── db:request IPC ──▶ main process ─┴──▶ duya-core.db
```

- `packages/agent-protocol/src/envelope.ts:157` already says adapters "live in
  `packages/agent-runtime/transport/*`". The package does not exist yet; this
  plan creates it.
- **Runtime = agent-server process.** It is the only process that sees both the
  host's request and the worker's event stream, so it is the only place a run
  can have an identity that spans them.
- **Control Plane = main process.** It owns SQLite (`db-bridge.ts` is the only
  writer), the session store, and policy. RFC §5.1 puts Storage and Durable
  Execution in the Control Plane layer for exactly this reason.
- **Control Plane is NOT a package.** `03-target-structure.md` §2 and RFC §3.3
  both rule it out as a package until wake ↔ automation is unwired. It is a
  directory under the host: `apps/desktop/src/main/control-plane/`.

---

## 3. Insertion point (why the UI cannot tell)

The renderer's entire chat footprint is **one** IPC call —
`agentServer.getUrl()` → `agent-server:getUrl` (`preload/index.ts:2801`).
Everything else is `fetch()` to `POST /sessions/:id/chat`
(`agent-http-client.ts:206`).

So the cut is server-side and total:

| Site | Change | UI impact |
|---|---|---|
| `handlePostChat`, before `workerManager.sendCommand({type:'chat:start'})` | `await deps.runOrchestrator?.openRun(...)` | none |
| `handlePostChatSSE`, the `data` listener that owns the turn | `normalizeWorkerEvent` → `normalizeAndObserve` (tee) | none |
| `handlePostChatSSE` `req.on('close')`, client-disconnect branch | `settleSession(id, { cancelRequested: true })` | none |
| `handlePostChat` `res.on('close')` | `settleSession(id)` backstop | none |
| `db-bridge.ts` | `+ run:create / run:append / run:complete / run:get / run:events / run:list-session` | none |

`normalizeWorkerEvent` output is written to the SSE response **unchanged**. The
legacy projection is a pure function of the protocol event, and the protocol
`RunEvent` is built from the same normalized frame — one source, two consumers.

### Three refinements the implementation forced

The plan above is the shape; three decisions below are corrections to it, each
forced by something found in the code rather than chosen for tidiness.

**1. Only the POST path observes, and only when `wantsSSE`.**
`handleGetChat` and `handlePostCompact` each attach their *own* `data` listener
and their *own* multi-line buffer to the same worker stdout. They are reconnect
views, not the turn. Observing from all of them would write each worker event
into `run_events` twice under two different run-scoped `seq` values whenever a
renderer held a POST stream and a GET stream at once. One run, one log: the POST
path opens the run, so the POST path is the only one that records.

The `wantsSSE` gate is the same reasoning one step earlier. `handlePostChatNonSSE`
parses stdout on its own and never routes through `normalizeWorkerEvent`, so a run
opened for it could record nothing but `run.started` and then settle with a cause
this host never observed — a fabricated `runtime_crash` for a turn that worked.
Not recording is honest; mis-recording is not.

**2. A client disconnect is a cancellation, not a crash.**
This plan originally claimed a disconnect "does not end the run; the worker keeps
producing". That is **false about this host**: the router's own
`req.on('close')` handler removes the stdout listener and calls
`interruptWorker` (`router.ts:1363`). The worker really does stop, because the
host asks it to. `resolveRunOutcome` reads silence as `runtime_crash`, so settling
there without the cancel flag would mean accusing the runtime of a failure this
very handler requested one line earlier. `settleSession(id, { cancelRequested: true })`
is wired into exactly that branch.

**3. The projection is for replay, never for the live stream.**
`normalizeAndObserve` *discards* the `legacy` frame `observeFrame` returns. The
projection is lossy by construction — many-to-one, and it drops fields the legacy
union never declared — so routing the live stream through it would quietly
truncate `goal_updated`, `mode_changed` and `tool_result` payloads. The live path
forwards the exact object the renderer parsed before Plan 586 existed.

---

## 4. `packages/agent-core` (pure, zero IO)

Declared `managed: true` in `architecture-policy.yaml:138`, so it is held to zero
boundary violations from its first commit. Depends on `@duya/agent-protocol` only.

Content is the part of run semantics that is **pure reasoning about a run** and
therefore testable with no process, no clock, and no database:

| Module | Responsibility |
|---|---|
| `run-outcome.ts` | Terminal-state resolution. First terminal wins; cancellation is `completed`, never `failed`; a hard kill is `failed{escalated}`. |
| `run-budget.ts` | Budget accounting from the event stream + `isBudgetExhausted`. |
| `durability-policy.ts` | Retain / count / drop per event type, derived from `EVENT_REGISTRY` rather than restated. |
| `capability-negotiation.ts` | Effective capability intersection + protocol-compatibility verdict. |

**Not** in this package: the model loop, prompt assembly, compaction, and the
`modes/` SCC. Those move later, once C1 has unwound the cycle — RFC §3.4 and
`03-target-structure.md` §5.1 both forbid claiming the cut exists when it does not.

## 5. `packages/agent-runtime` (the run engine)

Declared `managed: true` (`architecture-policy.yaml:145`).
Depends on `@duya/agent-protocol` + `@duya/agent-core`.

| Module | Responsibility |
|---|---|
| `controller.ts` | `AgentRuntimeApi` implementation: `start` / `resume` / `probe` / `capabilities`. |
| `run-session.ts` | Per-run state: `RunLedger` + projector + durable-event batching + terminal CAS. |
| `translate/chat-event-translator.ts` | Normalized router frame → `RunEvent`. A **production** adapter, deliberately allowed to differ from `protocol/testing/worker-adapter.ts` — and a conformance test diffs the two. |
| `project/legacy-sse-projector.ts` | `RunEventEnvelope` → legacy `{type, data}` SSE frame. This is what keeps the UI unchanged. |
| `transport/worker-command-channel.ts` | The narrow seam to the worker. Structural type, so the router supplies its own stdio channel and tests supply a script. |

### The `seq` decision

`envelope.ts:14-35` and `GAPS.md` G-8 document a live defect: the SSE counter
resets per POST (`router.ts:1329`) while `session.lastEventId` is per-session,
so turn two re-issues ids turn one already used.

**Decision: the runtime mints its own run-scoped `seq` (1..N, gapless) and the
legacy SSE `id:` is left exactly as it is.** The durable log is therefore correct
from the first Reference Run, the UI is untouched, and the pre-existing wire
defect stays a separate, separately-fixable item instead of being silently
inherited into storage. Recording it here rather than fixing it here is
deliberate: a wire change belongs to the router cutover, not to this slice.

---

## 6. Storage

Mirrors the `workflow_runs` / `workflow_run_events` pair
(`db/core/workflow-store.ts:257` / `:321`) — the same `(run_id, seq)` identity,
already proven to coexist in `duya-core.db`.

```sql
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  status TEXT NOT NULL,
  terminal TEXT,
  error_json TEXT,
  origin TEXT,
  metrics_json TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE TABLE run_events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);
```

Migration ids **35 / 36** — above the current core max of 34. The
`id <= current` collision that silently skipped the `origin` column
(`stores.ts:449-455`) is the reason the id is chosen by measurement, not by
counting from zero.

`manifest_json` stores the manifest verbatim, which is what makes
`manifestFingerprint` re-verifiable at resume: a rewritten manifest is
`manifest_mismatch`, not a silently different run.

---

## 7. Phases

| Phase | Deliverable | Gate |
|---|---|---|
| P0 | This plan + the two `package.json`/`tsconfig` skeletons | workspace resolves |
| P1 | `packages/agent-core` + tests | `typecheck:core`, vitest, `architecture:check` delta 0 |
| P2 | `packages/agent-runtime` + translator + projector + conformance test | `typecheck:runtime`, vitest |
| P3 | `RunStore` + manifest factory + `run:*` db-bridge actions | `npm test` (core DB suites) |
| P4 | `run-orchestrator.ts` + router wiring | `typecheck:all`, `npm test` |
| P5 | Build/lockfile wiring | `npm run build:agent`, `architecture:check` delta 0 |
| P6 | Evidence: closed-loop test + Electron smoke | gates + recorded output |

## 8. Non-goals

- No renderer, preload, or IPC-channel change. The UI contract is a test assertion, not a preference.
- No rewrite of the model loop.
- No `goalId` / `workspaceId` columns yet — S1/S2 of RFC §3.6 stay separate.
- No fix to the SSE `id:` collision. Recorded, not inherited.
- No `agent-tools` bag, no `packages/ui`, no cloud isolation (RFC §8).

## 9. Gates

```bash
npm run typecheck:all          # incl. the two new packages
npm run test                   # unit + core DB
npm run architecture:check     # delta vs the pre-change baseline must be 0
npm run build:agent            # esbuild resolves both new packages
```

`architecture:check` is **already red on master** (877 violations, 198 baselined,
743 stale fingerprints). The gate for this plan is therefore the *delta* against
`.tmp-validation/reference-run/arch-before.txt`, not an absolute zero — a claim
of "green" would be false.

---

## 10. As landed

### Files

New packages (both `managed: true`, zero-tolerance):

- `packages/agent-core/` — `run-outcome`, `run-budget`, `durability-policy`,
  `capability-negotiation`
- `packages/agent-runtime/` — `controller`, `run-session`,
  `translate/chat-event-translator`, `project/legacy-sse-projector`,
  `transport/execution-channel`

Host:

- `apps/desktop/src/main/control-plane/` — `manifest-factory`,
  `run-control-plane` (NOT a package; §2)
- `apps/desktop/src/main/db/core/run-store.ts` — migrations 35/36
- `apps/desktop/src/main/agents/server/run-orchestrator.ts` — hosts
  `RunController`, reaches the Control Plane over `db:request`

Modified: `router.ts` (tee + openRun + 2 settle sites), `db-bridge.ts` (6
`run:*` cases), `server/index.ts`, `db/core/index.ts`, `db/core-connection.ts`,
`package.json`, `vitest.config.ts`, `scripts/build-electron.mjs`,
`architecture-policy.yaml`, and the two audit scripts.

### Defects found while landing

Every one of these was found by a test or a gate, not by reading.

| # | Defect | Why no gate caught it earlier |
|---|---|---|
| 1 | `run.started` was batched with the rest, so a run that crashed on its first frame recorded nothing | Only visible as a *value* of the log, never as a failure |
| 2 | `RunController.start` did not await the first flush, making "recorded before executed" a race | Same |
| 3 | `run-orchestrator` held `#lastRunId` / `model` in single slots shared across sessions | Needs two interleaved runs to reproduce |
| 4 | `run-store.verifyManifest` re-hashed with a different algorithm than `manifestFingerprint` | Both hashes were stable; only a cross-check exposes it |
| 5 | `run-orchestrator` imported the `control-plane` **barrel**, dragging `better-sqlite3` + Electron config into a forked process | esbuild resolves it happily; it is a layering bug, not a build break |
| 6 | `capability-negotiation` demanded `replay` unconditionally, contradicting the reference | Only the conformance test disagreed |
| 7 | `text_delta` was folded into the durable `text_block` | — |
| 8 | Tool ids were not read out of the nested payload | — |
| 9 | `run-store.ts` imported `'../database'`; the file is `'./database'` (13 stores, 1 outlier) | **Type-only import**: esbuild erases it and `tsconfig.main.json` is not in the gate. Found by `architecture:check` as `UNRESOLVED:../database` |
| 10 | `moduleDependencyPermitted` matched roots by bare `startsWith`, so `packages/agent` "contained" `packages/agent-protocol` and `packages/agent-runtime` | Self-test refused to pass: 154 edges were waved through by a `requires` declaration they had nothing to do with |
| 11 | `apps/desktop` was not a declared module at all, so `moduleOf()` returned `null` for the whole host and the declared-dependency rule could not bind it | A check that cannot resolve its subject cannot report itself missing |
| 12 | The plan (and its first draft of the closed-loop test) asserted the durable `run_events` subset is gapless. It is not: a volatile event consumes a `seq` without a row | Only reproducible with a real volatile event in the stream — the isolated store tests never mixed buckets |
| 13 | **`RunStore` had no `migrations` static, so `collectMigrations()` spread `undefined` and threw — the app could not open its database at all** | `RunStore` was the only aggregate missing it, and nothing called `collectMigrations()`. esbuild does not evaluate, the main process is outside the typecheck gate, and no test exercised boot's migration composition. `run-store-migration.test.ts` does now |

Defects 9–11 and 13 are in the *governance and boot* layers, not the run layer.
They are recorded here because the plan's own gates depended on them: a
Reference Run whose architecture check is miscounting, or whose database cannot
be opened, is a Reference Run with no evidence.

Defect 13 deserves its own note, because it is the one that would have shipped.
`collectMigrations()` composes `<Store>.migrations` for every aggregate and hands
the result to the runner inside `initCoreDatabase`. `RunStore` exposed only a
named export, so the spread was `...undefined` — a `TypeError` on every boot,
before a single query ran. Every existing gate was blind to it by construction:
esbuild does not evaluate, `tsconfig.main.json` is outside the typecheck gate,
and no test in the repo called `collectMigrations()`. The fix follows the
repository's own convention (`static readonly migrations` on every other
aggregate, pointing at the same array rather than restating it), and
`run-store-migration.test.ts` now drives the REAL composed list — no duplicate
ids, run store above every pre-existing id, applied to an already-migrated
database with earlier rows still readable and the schema fingerprint unchanged
after a second application.

### Evidence

| Gate | Result |
|---|---|
| `npm run typecheck:all` | exit 0, zero errors |
| `node scripts/build-electron.mjs` | exit 0 — every import edge resolves |
| Plan tests | **150 passed** (59 core + 38 runtime + 22 control-plane + 11 orchestrator + 8 router tee + 5 closed loop + 7 migration) |
| `architecture-check --self-test` | **exit 0** (master: exit 2) |
| `architecture-check` blocking | **661** vs master's 679 — net **−18** |
| Zero-tolerance modules | `agent-core`, `agent-runtime`: **0 violations inside either** |
| Renderer / preload | `git status`: **zero paths touched** |
| Main-process deletions | `git diff --ignore-cr-at-eol`: the only two are the two lines this plan rewrites on purpose |

The 143 include two files that assert the load-bearing claims mechanically
rather than in prose.

`router-run-tee.test.ts` — the "UI unchanged" claim: the serialised SSE frame is
byte-identical whether or not the run layer is wired, and the tee hands **one
object** (identity, not deep equality) to both consumers.

`reference-run-closed-loop.test.ts` — the closed loop, end to end, against a real
SQLite file: real router normaliser → real orchestrator → real controller → real
ledger → real translator → real Control Plane → real rows, read back **directly
from the table** rather than through the store's own accessors. The only double
is the `ExecutionChannel`'s dispatch callback, which stands in for the worker
process — the one participant that would need an API key and a live model call.
That boundary is drawn at the worker, not at storage, so everything this plan
built is exercised. It covers the completed arm, the failed arm with its cause
preserved, a volatile event consuming a `seq` without a row, the read path with
its exclusive cursor, and two runs of one session on independent `seq` spaces.

Writing that test found something every other test had missed. The plan asserts
the durable subset of `run_events` is "gapless". It is not, and cannot be: a
volatile event still consumes a sequence number, so the rows after it sit at
6, 7, … A gap is the *record* of something that happened and was deliberately not
stored — the durable `seq` is a faithful index of the **stream**, not of the
rows. The test now asserts the invariant that is actually true and actually
useful (strictly increasing, never repeated, and every missing number accounted
for by a non-durable event), and a sibling test pins the count so that if a
durable event ever starts being dropped, or a volatile one starts being stored,
one of the two fails.

`run-store-migration.test.ts` — the boot path: the REAL `collectMigrations()`
composition (the same function `initCoreDatabase` calls, exported so the test
pins the real list instead of a copy that could drift) applied to a database
that is already built. Covers no-duplicate-ids, run-store-above-everything-else,
ordering, table creation with the columns the Control Plane reads, earlier rows
still readable afterwards, and an unchanged `sqlite_master` fingerprint when the
whole list is applied twice.

Writing that test found defect 13 below, which is the one that would have
shipped: `RunStore` was the only aggregate without a `migrations` static, so
`collectMigrations()` spread `undefined` and threw on **every boot**.

### Not yet done

`npm test` and `architecture:check` are red **on master** — 223 test failures and
679 blocking violations predate this plan (reproduced on a clean `master` via
`git stash`). This slice's claim is a delta, never a green.

**P6 remains open:** no real Electron smoke has run, because it needs a provider
key and a live model call. Everything above is code-path and test evidence; there
is no runtime screenshot.

