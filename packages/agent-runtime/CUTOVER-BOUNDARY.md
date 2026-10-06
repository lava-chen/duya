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
The cycle body is `:1825-3404` — 1580 lines — and it references exactly **36**
distinct `this.<member>` collaborators (counted over the comment-stripped body,
so prose is excluded).

> **Correction, measured on this slice.** This file previously said the body was
> `:1825-3300` and 1476 lines. Both were wrong. The body closes at **`:3404`**,
> found by brace-matching from the `while` head with comments and string literals
> stripped; `:3300` is a `return` inside the dead-loop hard stop
> (`DuyaAgent.ts:3297-3301`), roughly 100 lines short of the real close. The
> collaborator COUNT of 36 is unaffected and was re-verified independently, so
> only the span and the line count were stale. The count matters more than the
> span, and it did not move.

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

### H. Inter-turn input → `InterTurnInputPort` (`ports.ts`) — 1, and the port now EXISTS

| Collaborator | First use | Note |
| --- | --- | --- |
| `_sweepInterTurn` | `:2193` | 3 `this.`-qualified calls, at `:2193` before the model call and at `:3198`/`:3263` around the stop decision |

**Total 12 + 2 + 14 + 2 + 3 + 1 + 1 + 1 = 36.**

#### What changed in group H, and what did NOT change in the count

The row was `_claimMailboxAtCheckpoint`. It is now `_sweepInterTurn`, and the
count is **still 36, not 35**. Measured, and the reason is that this slice
builds the port rather than deleting anything: the legacy call sites are all
still there (deleting them is A3-2), and they now name a `this.<member>` that is
one member either way. The count drops to 35 only when `while (...)` at `:1825`
goes, because only then does the body stop referencing a host collaborator at
all.

What DID change is the row's meaning, and that is the part A3-2 inherits:

- **Was**: a collaborator with **no home** — "the only collaborator with no home
  at all", which is what made this file exist.
- **Now**: a collaborator with a **named port**. `_sweepInterTurn`
  (`DuyaAgent.ts:3651`) is the seam; the claim behind it is still the single
  private `_claimMailboxAtCheckpoint`, reached by the legacy directly and by the
  engine through `createInterTurnPort` (`process/inter-turn-port.ts`). One claim
  implementation, two callers, so there is no second authority for which rows a
  run owns.

Two properties of the new row that the old one did not have to state:

- The port is **REQUIRED** on `RunEnginePorts`, not optional. The engine is not
  live in production (`agent-process-entry.ts:3047` drives the turn through
  `DuyaAgent.streamChat`; the phantom engine run was removed at `:2989-3002`), so
  unlike `turnOutput` and `compaction` there is no window in which binding it
  double-claims. Composition surface, measured: **25 sites** build a
  `RunEnginePorts` value — 1 production (`buildEnginePorts`), 2 in
  `port-guards.ts`, 22 in tests. Requiring it is a 3-site typecheck change; the
  other 22 are test compositions and are mechanical.
- The engine asks at **three** points and honours all three decision arms. A
  forgotten binding is a COMPILE error rather than a `?.`, because an engine that
  skipped the sweep would publish every frame correctly and propose a clean
  `completed` while the user's mid-run correction never reached the model —
  and, unlike a skipped compaction, **no frame would be missing** for a consumer
  to notice.

#### A behaviour the legacy does NOT have, stated rather than hidden

The first stop-decision sweep (`:3198`) loops on an absorbing answer with **no
cap**; only the finalize poll (`:3263`) is bounded, at
`FINAL_POLL_MAX_ABSORBS = 3` (`:1819`). The engine reproduces that asymmetry
exactly — `run-engine.ts` caps the poll and not the first sweep — because a cap
on the wrong one of the two would be a behaviour change dressed as a
refinement. `inter-turn-input-port.test.ts` asserts the cap on the poll
specifically, with a script shaped `false, false, true` so the assertion is
about the poll and not the sweep.

## NEW PORT required — BUILT, in A3-1

Exactly one was needed: a mailbox/steering sweep. `_claimMailboxAtCheckpoint` was
called three times inside the cycle — `:2193` before the model call, and
`:3198`/`:3263` around the stop decision, where a non-null decision loops back to
give the model a fresh turn. Nothing in `ports.ts` expressed "the host may inject
input between turns": `RunInputSnapshot.steering` (`ports.ts:1204`) is fixed at
run start, so a mid-run mailbox cannot ride it. It was the only collaborator with
no home at all.

**It now exists**, as `InterTurnInputPort` (`ports.ts`, contract 1h), and it is
**required** on `RunEnginePorts`. Named for the capability rather than the
mechanism: a mailbox is one implementation, and naming the port after one host's
storage would put the word "mailbox" into a package that has no business knowing
it — the reason `ModelPort` is not `LlmClientPort`. The engine calls it at all
three points and honours all three decision arms.

Two things this slice deliberately did NOT do, because they are A3-2 and a
half-migrated loop is worse than no migration: it did not delete the legacy cycle
or `streamChat`, did not flip the driver in `agent-process-entry.ts`, and did not
bind `turnOutput` or make `compaction` required.

## The two blockers: BOTH RESOLVED, measured

Both were measured, not estimated, and both are why this file exists instead of a
diff. Both are now closed, and the evidence is below so the next reader does not
have to re-derive it. Nothing else about the cutover is unblocked: the loop still
has to move, and the fake green described further down is still the thing to
avoid producing.

### 1. The engine never called `CompactionPort` — RESOLVED

**Was.** `run-engine.ts` contained **zero** references to `compaction` or
`Compaction` (grep count: 0). `CompactionPort` was declared at `ports.ts:1978`
and `engine/compaction.ts:125` exported a working `runCompactionPass`, but the
engine's `for` loop never invoked either — so binding the port was not wiring,
it was an insertion.

**Now.** PR #234 added the three call sites through a `#compact` method
(`run-engine.ts:522`, `:592`, `:664`), matching the three decisions the legacy
owns: the proactive pass before the request, the emergency retry on a failed
model stream, and the preflight overflow check after the drain. The port is
still **OPTIONAL** on `RunEnginePorts` — correctly, and for the reason its own
doc comment gives: the legacy still drives every turn, so a bound port would
compact twice. The cutover is what makes it required.

### 2. The cycle contains a nested stream protocol — RESOLVED, and it was never a blocker for the engine

**Was.** `:2152-2187` runs a SECOND loop inside the cycle:
`while (compactionRun === null && compactionFailure === null)` (`:2170`) races a
compaction promise against an SSE queue that is `yield`-ed inline (`:2172`,
`:2180`). The stated reason is in the comment at `:2144-2151`: an async
generator cannot `yield` while awaiting a sub-promise, so the coordinator pushes
into a queue and the loop drains it on a short tick. On that reading, compaction
progress is interleaved into the response stream, and an engine with no inline
`yield` would have nowhere to put it.

**Why it is not a blocker, measured.** The constraint is a property of an async
GENERATOR, and the engine's transport is push-based. `engine/compaction.ts:150-152`
wires the port's `onProgress` straight to `events.publish`:

```ts
const onProgress = (progress: CompactionProgress): void => {
  events.publish(progressFrame(compactionId, progress));
};
```

So the real-time `compaction.step` / `over_threshold` frames survive the cutover
with **lower** latency than the legacy: the legacy's 50 ms tick
(`DuyaAgent.ts:2177`) is what a queue-and-drain loop costs, and the engine pays
nothing for it. `CompactionPort.run`'s `reporter` parameter was already the right
shape (`ports.ts`); the engine simply does not need a drain loop to honour it.

**What this changes for the cutover.** Nothing has to be re-invented and nothing
has to be ported. The nested loop disappears with the cycle it lives in, and the
frames it was interleaving are produced by `runCompactionPass` instead. The only
thing to carry across is the ORDERING, and `runCompactionPass` already states it
(`started` → progress → exactly one terminal, `compaction.ts:126-131`).

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
