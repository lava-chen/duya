# The A3 cutover boundary decision

Plan 610 slice A3, step 2. The order the plan sets is 先定边界再搬代码 — decide the
boundary, then move code. This file is that decision, and it is written BEFORE any
code moves because the decision is what makes the move safe or unsafe.

Nothing here has been implemented. This file records what a genuine cutover has to
satisfy, what it has to be given, and the two places where the engine cannot
currently host the loop at all.

## The loop, as measured

The legacy cycle is `while (!this.abortController.signal.aborted)` at
`packages/agent/src/agent/DuyaAgent.ts:1825`, inside `streamChat` (`:990-3434`).
The cycle body is `:1825-3300` — 1476 lines — and it references exactly **36**
distinct `this.<member>` collaborators (counted over the comment-stripped body,
so prose is excluded).

The four decision points it makes are named at `ports.ts:26-31`, and the engine
already owns all four: `for (let turn = 1; ; turn++)` at
`packages/agent-runtime/src/engine/run-engine.ts:355`, `ports.model.stream`,
`ports.tools.dispatch`, `ports.tools.drain`. `packages/agent-runtime` imports
`@duya/agent` nowhere, which is what makes the move legitimate rather than a
relocation of coupling.

## All 36 collaborators

Each row is one `this.<member>` read inside `:1825-3300`. "Host" means the value
stays where it is and the engine never sees it; "NEW PORT" means no port in
`ports.ts` can carry it today and one has to be written first.

### A. Model call → `ModelPort.stream` (`ports.ts:396`) — 12

| Collaborator | First use | Note |
| --- | --- | --- |
| `llmClient` | `:2387` | the client the leg opened |
| `_model` | `:1988` | |
| `provider` | `:1993` | |
| `apiKey` | `:1990` | |
| `baseURL` | `:1991` | |
| `authStyle` | `:1992` | |
| `runtimeConfig` | `:2394` | |
| `modelAttribution` | `:2678` | read after the drain |
| `lastSystemContextTokensEstimate` | `:2340` | |
| `lastSystemTokensEstimate` | `:2338` | |
| `lastToolsTokensEstimate` | `:2339` | |
| `_estimateSystemAndToolsTokens` | `:2337` | |

This group is the request the engine assembles, so all twelve collapse into one
`ModelPort`. `createClientModelPort` is named as the correct implementation at
`agent-process-entry.ts:3029-3031`.

### B. Tool dispatch and drain → `ToolPort` (`ports.ts:438`) — 2

| Collaborator | First use | Note |
| --- | --- | --- |
| `buildMCPToolExecutors` | `:2019` | feeds `ToolPort.dispatch` |
| `resolveMCPToolNameToInternalKey` | `:2018` | name translation for dispatch |

The pipeline itself is not a `this.` member: it is constructed per turn at
`:2067` (`new ToolExecutionPipeline(...)`) and drained at `:2764`
(`executor.getRemainingResults()`). Ownership of both is what the cutover moves.

### C. Context assembly → `ContextPort.assemble` / `.defer` (`ports.ts:478`) — 14

| Collaborator | First use | Note |
| --- | --- | --- |
| `timeline` | `:1935` | the turn history the model is built from |
| `modeCtx` | `:1857` | most-read collaborator in the cycle (10) |
| `resolvedModes` | `:1856` | |
| `baseSystemPromptWithoutModes` | `:1858` | |
| `widgetStyleHistory` | `:1863` | |
| `forkTurn` | `:1944` | |
| `canvasFreshness` | `:1978` | |
| `currentProjectId` | `:1983` | |
| `projectHome` | `:2003` | |
| `visualAnalysis` | `:2009` | |
| `_injectRuntimeContext` | `:2314` | |
| `_applyProviderThreadBoundary` | `:2306` | |
| `_projectModelMessages` | `:3037` | |
| `omitAgentsMd` | `:2953` | |

### D. Durable transcript and turn results → `TurnOutputPort` (`ports.ts:733`) — 2

| Collaborator | First use | Note |
| --- | --- | --- |
| `_pushDurable` | `:1950` | 4 uses, including the write the safety net pins at `:2804` |
| `_commitMessages` | `:2227` | 3 uses |

This port already carries the eleven drain rows enumerated at
`packages/agent/src/process/__tests__/engine-drain-carryover.test.ts:42-53`.

### E. Compaction → `CompactionPort` (`ports.ts:1978`) — 3, AND IT HAS NO ENGINE CALL SITE

| Collaborator | First use | Note |
| --- | --- | --- |
| `compactionManager` | `:1835` | 8 uses: `onTurnStart`, epoch, schema baseline, probe, usage anchors |
| `compactionCoordinator` | `:2155` | the async coordinator whose events are yielded inline |
| `compactionController` | `:3011` | `projectInputMessages`, `compactProactive` |

### F. Mode hooks → `ExtensionPort` (`ports.ts:1512`) — 1

| Collaborator | First use | Note |
| --- | --- | --- |
| `modeCoordinator` | `:3124` | post-turn mode change |

### G. Cancellation → the caller's `signal`, NOT a port to add — 1

| Collaborator | First use | Note |
| --- | --- | --- |
| `abortController` | `:1825` | `ports.ts:1076-1079` already makes `signal` caller-owned on purpose |

### H. Stays on the host — 1

| Collaborator | First use | Note |
| --- | --- | --- |
| `_claimMailboxAtCheckpoint` | `:2193` | 3 `this.`-qualified calls, at `:2193` before the model call and at `:3198`/`:3263` around the stop decision |

**Total 12 + 2 + 14 + 2 + 3 + 1 + 1 + 1 = 36.**

## NEW PORT required

Exactly one: a mailbox/steering sweep. `_claimMailboxAtCheckpoint` is called three
times inside the cycle — `:2193` before the model call, and `:3198`/`:3263`
around the stop decision, where a non-null decision loops back to give the model a
fresh turn. Nothing in `ports.ts` expresses "the host may inject input between
turns": `RunInputSnapshot.steering` (`ports.ts:1204`) is fixed at run start, so a
mid-run mailbox cannot ride it. This is the only collaborator with no home at all.

## The two blockers, measured

Both are measured, not estimated, and both are why this file exists instead of a
diff.

### 1. The engine never calls `CompactionPort`

`run-engine.ts` is 2151 lines and contains **zero** references to `compaction`
or `Compaction` (grep count: 0). `CompactionPort` is declared at `ports.ts:1978`
and `engine/compaction.ts:125` exports a working `runCompactionPass`, but the
engine's `for` loop never invokes either.

So binding `CompactionPort` is not wiring. Someone has to first INSERT compaction
into the engine loop at the points the legacy owns them: `onTurnStart` (`:1835`),
the pre-turn coordinator (`:2155`), the preflight probe and run (`:3018`,
`:3022`), the usage anchors (`:3154-3167`), and the emergency path (`:3330`,
`:3360`). Until that exists, moving the loop without it means no transcript is
ever replaced and the five compaction frames have no producer — which
`ports.ts:1055-1058` states is explicitly not a harmless omission.

### 2. The cycle contains a nested stream protocol, not just calls

`:2152-2187` runs a SECOND loop inside the cycle:
`while (compactionRun === null && compactionFailure === null)` (`:2170`) races a
compaction promise against an SSE queue that is `yield`-ed inline
(`:2172`, `:2180`). Compaction progress is therefore interleaved into the
response stream, not merely applied to the transcript.

`CompactionPort.run` does take a `reporter` callback
(`ports.ts:2005-2009`), so the shape is anticipated — but nothing in the engine
yields engine-loop output to a reporter mid-turn, so this is a second insertion
into the loop, not a port binding.

## What a green G7 does and does not prove

`isTurnLoopModule` (`scripts/architecture/boundary-gates.mjs:319-326`) is a
CONJUNCTION of three clauses, so a module stops matching when ANY ONE clause goes
false. Measured on the comment-stripped `DuyaAgent.ts` today:

- `repetition` — 37 matches, of which **29 are outside the cycle** (e.g. `:902`,
  `:1112`, `:4487`, `:5046`), in unrelated methods.
- `modelStream` — 2 matches: `:95` (`import { buildTurnModelLeg }`) and `:2454`.
- `toolExecution` — 7 matches: `:76`, `:2067`, `:2762`, `:2764`, `:2902`, and
  `:4427` (`orchestrator.execute(`, outside the cycle).

Therefore deleting the dead model leg at `:95`/`:2454` ALONE flips
`isTurnLoopModule(DuyaAgent.ts)` to false and takes G7 to `new: 0` **with the
1476-line cycle still in place**. `agent-process-entry.ts:3032-3036` already
records that the leg has no reader.

That is the fake green `ports.ts:12-15` documents, and this slice does not
produce it. A green G7 from this work has to come with `runTurnStream` gone from
`DuyaAgent.ts` and `while (...)` at `:1825` gone with it — which is the two
blockers above, not a deletion.

## The `discarded` latch constraint on any design that follows

`StreamingToolExecutor.discarded` is a one-way latch: declared `false` at
`StreamingToolExecutor.ts:479`, documented as never cleared at `:729-732`, and
it aborts `siblingAbortController` at `:758`. The legacy calls `discard()` at
`DuyaAgent.ts:2407` (retry reset), `:2746` and `:3368`. Construction is per turn
at `:2067`.

Consequence for the cutover: if the pipeline becomes a port binding and is held
across turns, one `discard()` mutes it for the rest of the run — it accepts
tools, drains nothing, raises no error, and passes every structural test. The
publish stays on the existing `TurnPipelinePublisher` (constructed per run in
`agent-process-entry.ts`, asserted at
`packages/agent/src/process/__tests__/live-turn-single-driver.test.ts:207-209`),
and the next pass must keep the pipeline lifetime per turn or prove it cannot go
mute. Do not add a second publisher.
