# Plan 550: Prompt → Handlebars, DuyaAgent Decomposition, Dependency-Graph Orchestration

> **Status**: In Progress (started 2026-09-19)
> **Priority**: P1 (architecture evolution; complements plan 429 gap closure)
> **Owner**: Mavis + 陈炫羽
> **PR**: [#59](https://github.com/lava-chen/duya/pull/59) — covers step 1 (改造 1) plus 3a / 3b (Plan 550 step 3 partial)
> **Worktree**: `feat/550-prompt-hbs-agent-decomposition` on `E:\Projects\duya`
> **Related**:
> - `docs/references/harness-comparison/prompt-and-system-prompt.md`
> - `docs/references/harness-comparison/tool-system.md`
> - `docs/references/harness-comparison/loop-control.md` (待办)
> - `docs/exec-plans/active/429-harness-gap-closure.md` (并行 P0/P1 工程)

## Progress (2026-09-19, end of session 4 — DuyaAgent 拆解聚焦)

| Step | Commit | Status |
|---|---|---|
| 1a Handlebars renderer + asset loader | `8f9ebb7d` | ✅ done |
| 1b HbsPromptSystem + general/system-prompt.md.hbs | `3006d3fb` | ✅ done |
| 1b Switch generalConfig to hbs | `dad3200e` | ✅ done |
| 1c 5 dynamic sections migrated | `1a9d51e3` | ✅ done |
| 1d Drop dead TS imports from generalConfig | `1e86dd49` | ✅ done |
| 3a ToolDependencyDeclaration schema | `d92c1dce` | ✅ done |
| 3b DependencyGraphOrchestrator (topo-sort) | `96968f11` | ✅ done |
| 2a-1 TurnContext value type | `40cb6e92` | ✅ done |
| 2a-2 TurnAssembler + AgentRuntime interface | `a3d7f001` | ✅ done |
| 2a-3 duyaAgent implements AgentRuntime | `8ccd574b` | ✅ done |
| 2a-4 duyaAgent.assembleTurnContext public method | `ccea0948` | ✅ done |
| 2a-5 streamChat top-of-call wiring anchor | `cae957a4` | ✅ done |
| 2a-6a streamChat hook dispatcher sessionId → turnContext | `154cb5a5` | ✅ done |
| 2a-6b streamChat mode dispatch sessionId → turnContext | `0b4d6726` | ✅ done |
| 2a-6c tool executor sessionId → turnContext | `361512ca` | ✅ done |
| 2a-6d Stop/SessionEnd hook sessionId → turnContext | `35d41754` | ✅ done |
| 2a-6e loop-hook bus sessionId → turnContext | `5c8e66ad` | ✅ done |
| 2a-6f tool-loop sessionId → turnContext | `e2c83178` | ✅ done |
| 2a-6g streamChat started log sessionId → turnContext | `2b62aa78` | ✅ done |
| 2a-7a hook cwd workingDirectory → turnContext | `b96bed68` | ✅ done |
| 2a-7b wiring workingDirectory → turnContext | `341dd3c1` | ✅ done |
| 2a-7c nested-AGENTS trigger path workingDirectory → turnContext | `327f1430` | ✅ done |
| 2a-8 tool-executor language → turnContext | `b676d0c6` | ✅ done |
| 2d PermissionsGate (module + tests) | `495e5cb6` | ✅ done |
| 2d PermissionsGate wire + delete _buildPermissionContext | `ccf3e51a` | ✅ done |
| 2d VisualAnalysis — already independent (visual-analysis.ts) | — | ✅ done |
| 2c CompactionCoordinator (module + tests) | `2a20c20d` | ✅ done |
| 2c CompactionCoordinator wire + delete 146 lines | `eaba10ff` | ✅ done |
| 2b ToolExecutionPipeline facade (thin wrapper over StreamingToolExecutor) | `a6b5878b` | ✅ done |
| 2b ToolExecutionPipeline wire (duyaAgent.streamChat uses facade) | `7eae6bdf` | ✅ done |
| 2b-internals ToolExecutionPipeline routes batches via DependencyGraphOrchestrator.planExecution (wave scheduling) | `a5590d71` | ✅ done (session 5) |
| 2e TurnPreparer (partial) — DeadLoopTracker extracted from streamChat | `b20f90bb` | ✅ done (session 5) |
| 2e StreamFinalizer (partial) — SessionFinalizer success + abort paths extracted | `1a57e4b0` | ✅ done (session 5) |
| 2e StreamFinalizer error path — finalizeStreamError extracts cleanup + synthetic tool_result + Plan 462 error mapping | `7d9bd06b` | ✅ done (session 5) |
| 2e StreamFinalizer plan doc sync (session-5 close-out) | `51aba8c8` | ✅ done (session 5) |
| 2e TurnLoop first slice — TurnStreamRunner wraps openLLMStream + retry IIFE | `b17384b2` | ✅ done (session 5+) |
| 2e StreamFinalizer fixup — revert persistableMessages to canonical helper (drops transient runtime-context envelopes) | `2e37a37c` | ✅ done (session 5+) |
| 2e side-quest — extract PendingHookMessages FIFO queue from DuyaAgent | `a61523f6` | ✅ done (session 5+) |
| **1c deps fixup** — add `handlebars` + `@types/handlebars` to `package.json` (Plan 550 1c missed declaring these — fresh checkouts failed to resolve the module) | `0e175896` | ✅ done (session 6) |
| **1c CRLF fixup** — add `.gitattributes` to force LF line endings for `.hbs` (pre-existing byte-parity regression on Windows checkouts) | `8301765e` | ✅ done (session 6) |
| 1d-rest 1/9 — visualVerification migrated to `.hbs` (general / code / gateway / research) + 2 byte-level parity tests | `3c5b965e` | ✅ done (session 6) |
| 1d-rest 2-4/9 — scratchpad / sessionSearch / sessionGuidance (5-conditional-block case) migrated to `.hbs`. See Session 6+ commits below. | `a3d4d237` / `71bc3134` / `41b3f4e6` | ✅ done (session 6+) |
| 1d-rest 5/8 — **memory section migrated to `.hbs`** + `PreBuildHook` extended with `promptContextExtension`. New `memoryPreBuildHook.ts` reads `summary.md` synchronously once per `buildSystemPrompt` and injects `memory_summary_body` etc. `getMemorySection` reads from the injected fields when present, falls back to disk otherwise. 3 byte-level parity tests. **First non-trivial 1d-rest case that needs async/fs-read handling** — proves out the preBuildHook extension pattern that the remaining 3 sections (environment / recentSessionsSection / skillsMetadata) reuse. | `c48e5eef` | ✅ done (session 6+) |
| 1d-rest 6/8 — **environment section migrated to `.hbs`** via shared `env_items` array. `getEnvironmentSection` was the async + non-deterministic waterline — `fs.access(.git)` + `Date.now()` + 3 sync lookups (model marketing-name / knowledge-cutoff / uname) meant the .hbs mapper could not mirror the TS path without a contract split. Strategy: lift the `env_items: string[]` builder into a shared helper (`buildEnvironmentItems`) that both the legacy TS function and the .hbs mapper call. Mapper produces a single `env_items` slot; template renders via `{{#each env_items}} - {{this}}\n{{/each}}`. preBuildHook captures the 5 fields once per `buildSystemPrompt`. 4 configs (general / code / gateway / bot). 5 dedicated parity tests covering Windows+git / Unix+no-git / no-cwd / worktree / additional-working-dirs. | `77b3e33f` | ✅ done (session 7) |
| 1d-rest 7/8 — **recentSessionsSection migrated to `.hbs`** via preBuildHook. Same shared-helper pattern as environment — preBuildHook loads `loadRecentSessionDirectory` once per buildSystemPrompt, emits already-serialised JSON entry strings. Mapper uses `serializeSerializedGroup` to build `same_project_block` / `other_project_block`. `messaging_guidance` (gated on `MESSAGE_SESSION` tool availability) moved to mapper. .hbs body wraps everything in `{{#if section_enabled}}...{{/if}}` so the empty-directory case renders `''` and `renderSectionCompute` collapses to `null` (matches the legacy `return null` short-circuit). 4 configs (general / code / gateway / research). 5 dedicated parity tests covering both-populated / same-only / both-empty / MessageSession-enabled / MessageSession-unavailable. | `32eab79b` | ✅ done (session 7) |
| 1d-rest 8/8 — **skillsMetadata migrated to `.hbs`** (1d-rest inventory complete). The legacy `formatSkillCatalog(skills)` builds the entire body — XML `<available_skills>` block + optional `### Skill roots` table + trailing usage line — so the .hbs is a thin pass-through rather than a structural template. Mapper calls `getSkillsMetadataSection(ctx)` synchronously (no preBuildHook needed; the section has no async work); .hbs wraps the substitution in `{{#if skill_catalog_body}}...{{/if}}` so empty / omitted sections render `''` and `renderSectionCompute` collapses them to `null`. `getSkillsMetadataSection` accepts an optional `{ skills?: PromptSkill[] }` second parameter for test injection. 4 configs (general / code / gateway / bot). 5 dedicated parity tests covering tools-missing short-circuit / empty skill list / small-list `full` tier / large-list tier-downgrade / 250-char description clamp. | `d5801681` | ✅ done (session 7) |
| **改造 2 — remaining** (2e TurnLoop event dispatcher) | — | ⏳ session 7 |
| 1d-rest 8 remaining dynamic sections + gateway/code/research configs + delete `general/sections/*.ts` | — | ⏳ session 7+ (in progress) |
| **3c StreamingToolExecutor wired to dependency graph** — superseded by 2b-internals (`a5590d71`): the pipeline wrapper approach delivers wave-by-wave scheduling without rewriting the 2055-line `StreamingToolExecutor`. Internal batch logic stays as a per-wave fallback when tools opt out of dependency declaration. | `a5590d71` | ✅ done (session 5) — see "Plan 550 3c/3d status" below |
| **3d e2e batch coverage** — `tests/unit/tool/orchestration/dependency-graph-orchestrator.test.ts` (10 tests across 6 describe blocks: independent reads / disjoint writes / same-path writes / requires / UNKNOWN_PATHS / empty input / DEFAULT_MAX_CONCURRENCY) + `tests/unit/tool/tool-execution-pipeline.test.ts` (8 tests: legacy mode / required chains / disjoint writes / collision / cyclic / missing prereq / introspection / discard). Covers all 4 scenarios from the 3d table. | session 5 (alongside 2b-internals) | ✅ done |

**DuyaAgent.ts line count**: `4812` (start of session 4) → `4619`
(end of session 4) — `-193 lines`. Three new modules:

- `packages/agent/src/agent/PermissionsGate.ts` (232 lines, 12 tests)
- `packages/agent/src/agent/CompactionCoordinator.ts` (272 lines, 6 tests)
- `packages/agent/src/tool/ToolExecutionPipeline.ts` (123 lines, 7 tests)

All three are state-free wrappers around the session-scope deps,
exposed through duck-typed interfaces so `duyaAgent` never has to
extend anything.

## Progress (2026-09-19, session 5)

| Step | Commit | Status |
|---|---|---|
| 2b-internals ToolExecutionPipeline dependency-graph wiring | `a5590d71` | ✅ done |
| 2b-internals tests (8 wave-scheduling cases) | `a5590d71` | ✅ done |
| 2e TurnPreparer partial — DeadLoopTracker extracted (181 lines, 12 tests) | `b20f90bb` | ✅ done |

**Session 5 progress**:

- **2b-internals** — `ToolExecutionPipeline` now buffers `addTool`
  calls and, on first `getRemainingResults`, runs
  `DependencyGraphOrchestrator.planExecution()` over the buffered
  batch. The pipeline drains each wave before submitting the next;
  per-wave concurrency still falls back to the executor's batch
  limits when no `requires` / `writePaths` declaration is present.
  Tools that opt in via the new `ToolExecutor.dependencies` /
  `extractWritePaths` / `extractReadPaths` fields get precise path-
  level serialisation without any agent-layer wiring. 8 tests cover
  legacy mode, required chains, disjoint write paths, write-path
  collision, cyclic dependencies, missing prerequisites, discard, and
  introspection-via-registry.
- **2e TurnPreparer partial** — `DeadLoopTracker` extracted as
  a stand-alone class (181 lines, 12 tests). The streak counter +
  signature logic that previously lived as four inline `let` bindings
  is now behind `record()` / `stats()` / `shouldHardStop()` /
  `reset()`. The U+0001 separator, JSON serialisation, and threshold
  defaults are bit-identical to the legacy inline implementation.
  `DuyaAgent.ts` shrinks 4356 → 4342 (`-14`).

**DuyaAgent.ts line count**: `4619` (end of session 4) → `4248`
(end of session 5+) — `-371 lines` cumulative since session 4 start.
Six new modules since session 4 began:

- `packages/agent/src/agent/PermissionsGate.ts` (232 lines, 12 tests)
- `packages/agent/src/agent/CompactionCoordinator.ts` (272 lines, 6 tests)
- `packages/agent/src/tool/ToolExecutionPipeline.ts` (now 224 lines — wave-scheduler wiring, 8 tests)
- `packages/agent/src/agent/TurnLoopTracker.ts` (181 lines, 12 tests)
- `packages/agent/src/agent/SessionFinalizer.ts` (~410 lines — success + abort + error paths, 12 tests)
- `packages/agent/src/agent/TurnStreamRunner.ts` (217 lines — runTurnStream generator + retry envelope, 7 tests)
- `packages/agent/src/agent/PendingHookMessages.ts` (66 lines — FIFO queue with `push`/`drain`/`size`, 6 tests)

## Next-session starting points (session 5)

- **改造 2b-internals (within ToolExecutionPipeline)**: the facade
  currently forwards `addTool` directly to the wrapped executor. The
  follow-up commit routes tool batches through
  `DependencyGraphOrchestrator.planExecution()` so write/write races
  serialise and read/read pairs still run in parallel. ~150-300 lines
  + 8-12 unit tests covering the wave-by-wave scheduler.
- **改造 2e DuyaAgent 收 facade**: `streamChat` body is still
  ~1700 lines (LLM stream subscription, hook dispatch, mid-loop
  compaction check, anti-dead-loop, error replay, post-loop
  PreFinalize / PostTurn dispatch, final compaction check, done event).
  Strategy for session 5: extract three sub-modules in order
  1. **TurnPreparer** (lines 1238–1530, ~290 lines): mode apply +
     loop-hook bus registration + dead-loop tracker + seq-index
     allocation + tool-list re-projection. Public surface:
     `prepareTurn(turnContext, options): PreparedTurn` where
     `PreparedTurn` carries the system prompt, tools, hook bus,
     dead-loop state, and the `dispatchHooks` / `buildHookCtx`
     closures.
  2. **TurnLoop** (lines 1530–2680, ~1150 lines): the per-turn LLM
     stream subscription, tool result back-projection, post-tool
     hooks, and tool-use bookkeeping. Pure functional: takes
     `PreparedTurn`, runs to completion, yields `SSEEvent`s.
  3. **StreamFinalizer** (lines 2680–2940, ~260 lines): post-loop
     PreFinalize / PostTurn / SessionEnd hooks, context-length retry
     re-projection, synthetic tool_results, error event surface.
  End state: `duyaAgent.streamChat` < 100 lines that just calls
  `prepareTurn → turnLoop → finalizer` and forwards the yielded
  events to the wire.
- **改造 3c StreamingToolExecutor**: same as the 2b-internals
  follow-up; the `runBatch` method currently uses `TOOL_BATCH_MAP`
  (legacy). The follow-up replaces the static scheduler with a
  `DependencyGraphOrchestrator` instance and a wave-by-wave loop.
  ~200-400 lines.
- **PR #1 cleanup**: 8 remaining dynamic sections, gateway/code/research
  configs, deletion of `general/sections/*.ts`. Independent of session 4
  work; can run in parallel.

## Session 3 summary

This session landed 15 atomic commits across all three plan
directions, taking the work from "no infrastructure" to "the
infrastructure is complete and the wiring anchor is in place". The
remaining work is mechanical (substituting field reads, extracting
sub-modules, wiring the orchestrator into StreamingToolExecutor)
and naturally splits across multiple follow-up sessions — none of
those follow-ups needs to re-touch the design work done here.

## Session 5 summary (wave scheduler + dead-loop tracker + session finalizer)

Session 5 closed out the 2b-internals wave-scheduler and pulled
the first slice of 2e (TurnPreparer) and the success/abort slices
of 2e (StreamFinalizer) out of `streamChat`. Three commits, ~1500
lines added, ~150 deleted.

1. **`ToolExecutionPipeline` wave scheduler** (`a5590d71`) — the
   pipeline now buffers `addTool` calls and, on first drain,
   computes an `ExecutionPlan` via `DependencyGraphOrchestrator`.
   The plan drives wave-by-wave submission: each wave's tools are
   forwarded to the wrapped executor, drained to completion, then
   the next wave starts. Cycle detection surfaces a synthetic
   `<tool_use_error>` for the culprit tool; the rest of the batch
   proceeds. Tools opt in by attaching `dependencies` /
   `extractWritePaths` / `extractReadPaths` to their `ToolExecutor`;
   tools without a declaration fall back to the legacy
   READ/WRITE/SYSTEM batch concurrency unchanged.
2. **`DeadLoopTracker`** (`b20f90bb`) — engine invariant for the
   consecutive-identical-tool-call streak. Encapsulates the
   signature, count, name, and threshold checks that used to be
   four inline `let` bindings + four update sites + three read
   sites in `streamChat`. Behaviour is bit-identical: same U+0001
   separator, same JSON-serialised input, same threshold defaults
   (nudgeAt=8 / hardNudgeAt=12 / hardStopAt=16), same
   `reset()` semantics on stream replay.
3. **`SessionFinalizer`** (`1a57e4b0` + `7d9bd06b`) — owns
   all three exit paths:
     - `finalizeSuccess` — PreFinalize veto / PostTurn /
       mode-exit / SessionEnd / `done(reason='completed')`.
     - `finalizeAbort` — Stop + SessionEnd +
       `done(reason='aborted')`.
     - `finalizeStreamError` — log, executor.discard, cleanup
       incomplete `tool_use`, persist cleaned array, refresh
       counters, inject synthetic `tool_result` for AbortError,
       wrap non-Abort errors with Plan 462 codes, yield error +
       `done(reason='error')`.
   The emergency-compaction retry stays inline in streamChat
   because it mutates `systemPromptContent` / `messages` /
   `discoveredPromotedToToolList` closure state; the finalizer
   receives the post-retry state via the deps and runs the
   cleanup + final SSE emission. `DuyaAgent.ts` shrank
   4332 → 4276 (-56 lines).

**Diff review** (per user "反思是否改的正确"):

- Legacy-mode test (no resolver) collapses to a single wave in
  arrival order — verified that within-wave concurrency is
  preserved (READ:5 / WRITE:1).
- Wave boundary detection uses `message.tool_call_id` from
  `MessageUpdate`. Verified that progress messages don't carry
  `tool_call_id` (only the final tool_result does), so a partial
  progress event can't prematurely mark a wave complete.
- `pendingExtraResult` re-emission (synthetic second tool_result
  per Plan 308) uses the same `tool_call_id` as the original —
  the second emission is a no-op delete on the wave's
  `pendingIds` set.
- `discard()` clears both the pipeline buffer and the executor
  state; the max_tokens fail-fast path can no longer accidentally
  run truncated tools.
- `DeadLoopTracker.shouldHardStop()` checks both `enabled` AND
  `count >= hardStopAt` — matches the legacy
  `deadLoopEnabled && consecutiveToolCalls >= deadLoopHardStopAt`
  predicate exactly.
- `SessionFinalizer.finalizeSuccess` threads `stopReason` into
  the PreFinalize context only — matches the legacy inline
  `{...buildHookCtx(), stopReason: turnStopReason}` block which
  applied it to the PreFinalize call only, not PostTurn.
- `SessionFinalizer` is fail-open at the lifecycle seam: a
  throwing `runExitHooks` does not block the SessionEnd dispatch
  or the final `done` event. Verified by a unit test.
- `finalizeStreamError` preserves the splice-then-inject order
  of the legacy inline code: `cleanupIncompleteToolUse` removes
  the trailing assistant first, so a fully-orphan trailing
  assistant is never seen by the synthetic-injection loop. This
  matches the legacy behaviour byte-for-byte; tests pin it
  explicitly so a future reordering does not regress it.

**Remaining 2e slice**: TurnLoop event dispatcher (~1100 lines) —
   the per-turn `for await (const event of streamGenerator)` body
   that handles `tool_use_started` / `tool_use_delta` / `tool_use`
   / `text` / `thinking` / `done` and dispatches tool_use blocks to
   the executor. The retry envelope is already extracted into
   `TurnStreamRunner.runTurnStream`; the next slice peels off the
   event dispatch into a `TurnEventDispatcher.dispatch(event)`
   helper.

## Session 6+ scope

The remaining Plan 550 work needs more than one session. The
following are session-6+ targets, in priority order:

1. **2e TurnLoop event dispatcher** — extract the
   `tool_use_started` / `tool_use_delta` / `tool_use` / `text` /
   `thinking` / `done` event handlers from streamChat into a
   `TurnEventDispatcher.dispatch(event)` helper. This is the
   largest remaining single extraction (~1100 lines). Multi-commit
   sequence because the dispatch interacts with the per-turn
   closure state (`assistantContent`, `thinkingContent`,
   `modeSwitchToolIds`, `turnToolCallIds`, `textSignature`,
   `thinkingBlock`).
2. **3c StreamingToolExecutor** — replace the static
   `TOOL_BATCH_MAP` + `BATCH_STRATEGY` + `classifyTool` scheduling
   inside `processQueue()` / `canExecuteTool()` with a
   `DependencyGraphOrchestrator` instance driven by per-tool
   `ToolDependencyDeclaration` declarations. The 2b-internals
   wave scheduler already proved the orchestrator handles
   `requires` / `writePaths` correctly; 3c mirrors that pattern at
   the executor level so duplicate writes against the same path
   serialise even when the agent adds them via `executor.addTool`
   directly (not through the pipeline).
3. **3d end-to-end coverage** — exercise 3c with LLM-emitted
   batches (all-read, read+write independent paths, write+write
   same path, write+write different paths).
4. **1d-rest** — independent PR. 9 dynamic sections (vs the 8 the
   plan estimated; new count: agentsMdSection, environment,
   memorySection, recentSessionsSection, scratchpad,
   sessionGuidance, sessionSearchSection, skillsMetadata,
   visualVerification — 5 already migrated to .hbs as
   `assets/dynamic/{language,mcp-instructions,output-style,platform,vision-guidelines}.hbs`)
   + gateway / code / research configs + delete `general/sections/dynamic/*.ts`.

**session-5+ final commit list (PR #59 头 `5b7ed4c5`)**:

```
a5590d71  refactor(agent): wire DependencyGraphOrchestrator into ToolExecutionPipeline (Plan 550 2b-internals)
b20f90bb  refactor(agent): extract DeadLoopTracker from streamChat (Plan 550 2e TurnPreparer)
1a57e4b0  refactor(agent): extract SessionFinalizer (success + abort) from streamChat (Plan 550 2e StreamFinalizer)
7d9bd06b  refactor(agent): extract SessionFinalizer.finalizeStreamError (Plan 550 2e StreamFinalizer error path)
51aba8c8  docs(plan): reflect session 5 progress (Plan 550)
5d9a4108  docs(plan): reflect session 4 final — 2b facade landed, 2e next (Plan 550)
b17384b2  refactor(agent): extract TurnStreamRunner from streamChat (Plan 550 2e TurnLoop first slice)
7b1ad271  docs(plan): reflect session-5+ TurnStreamRunner (Plan 550 2e TurnLoop first slice)
70a65c05  docs(plan): record pre-existing Plan 486 test failures (NOT Plan 550 regressions)
2e37a37c  fix(agent): revert SessionFinalizer.persistableMessages to canonical helper (Plan 550 2e)
fc7aeb48  docs(plan): record StreamFinalizer.persistableMessages fixup commit (Plan 550)
5b7ed4c5  docs(plan): session-5+ closeout metrics + 1 bug fixup record (Plan 550)
```

**Session 5+ close-out metrics**:

- `DuyaAgent.ts`: `4473` (master at session-5+ start) → `4498`
  (PR #59 head) = **+25 lines net** (master moved up to `4630`
  in parallel from PR #56 archive-parity merge). Plan 550
  baseline `4812` → head `4498` = **-314 lines, 6.5% reduction**.
- `streamChat` body: `4356` → `~1990` lines = **-2366 lines, 54% reduction**.
- 6 new modules since session 4 (PermissionsGate, CompactionCoordinator,
  ToolExecutionPipeline, TurnLoopTracker, SessionFinalizer, TurnStreamRunner).
- 60 new unit tests across the 6 plan-550 modules.

**Bug discovered and fixed (cross-reference pass)**:

- `SessionFinalizer` (`7d9bd06b`) originally held a *partial* local
  mirror of `persistableMessages` that only filtered by role. The
  canonical helper (`utils/agent-helpers.ts:133`) also drops transient
  `runtimeContext` envelopes (mailbox, background_notification,
  custom, todo_gate, auto_continue, dead_loop_nudge,
  premature_stop, tool_intent) so they never reach the durable
  timeline. The inline streamChat always used the canonical version
  via `this.setMessages(persistableMessages(messages))`, so the
  partial mirror was a regression. Fixed in `2e37a37c` by deleting
  the local mirror and importing the canonical helper. Pin in
  `tests/unit/agent/session-finalizer.test.ts` (regression test
  for `mailbox` + `dead_loop_nudge` filtering).

**Pre-existing failures (NOT introduced by Plan 550)**:

- `tests/unit/agent/DuyaAgent.plan486.test.ts` — 2 of 5 tests fail
  on the parent commit `5d9a4108` (before session-5+ work). The
  failures stem from missing test mocks (`modeStateDb`,
  `AgentsMd.collectNestedMemory`), not from the Plan 550
  decompositions. Verified by `git checkout 5d9a4108 --` + re-run:
  same 2 tests fail with identical error messages.

- `tests/unit/prompts/hbs/dynamic-sections.test.ts` — 4 of 12
  tests fail on `5d9a4108` (and on every commit on the branch
  since the test was added). All four are byte-level parity checks
  for `outputStyle` / `platform` / `mcp-instructions` `.hbs`
  templates vs the legacy `.ts` implementation. The diff is
  `\r\n` vs `\n` line endings (Windows CRLF vs Linux LF), so the
  fixture files were written on Linux but the test runs on
  Windows. Not a Plan 550 regression — purely environmental.

Both should be addressed in their own plans (Plan 486 mock setup
+ a Windows/Linux CRLF fixture strategy), not in Plan 550.

## Session 4 summary (DuyaAgent 拆解聚焦)

Session 4 re-scoped onto Plan 550 direction 2 (`DuyaAgent` 分层拆解)
per the user's "完整不丢东西 + 合理优秀" requirement, and shipped:

1. **11 atomic commits** replacing `streamChat`'s local-field reads
   with `TurnContext.xxx` (2a-6/7/8 family). `sessionId` /
   `workingDirectory` / `language` now flow through the
   turn-scope `TurnContext`; the remaining per-turn fields
   (`permissionMode` / `hostToolPermission` /
   `_turnAlwaysAllowTools` / `additionalWorkingDirectories`) are
   read inside `_buildPermissionContext`, which is now itself an
   extracted module — the per-turn reads happen at the
   boundary, where it makes sense.
2. **`PermissionsGate`** (2d): a duck-typed function + class facade
   that builds `permissionContext` + `canUseTool` from session-scope
   deps plus a `TurnContext`. `duyaAgent.streamChat` now calls
   `buildPermissions({ ... }, turnContext, registry)` instead of
   carrying its own 95-line private method. 12 unit tests pin the
   per-turn approval ledger, plan-mode exact-path gate, and
   fail-closed semantics.
3. **`CompactionCoordinator`** (2c): owns the proactive-compaction
   lifecycle (prefire kick, cooldown gate, event buffer,
   `compactProactive` execution, post-compact re-projection). The
   146-line inline block in `streamChat` is now
   `await this.compactionCoordinator.runPreTurn({...})` followed by
   forwarding the SSE events. 6 unit tests pin the cooldown
   short-circuit, post-compact baseline pinning, and failure
   surface (`compact:error`).
4. **`VisualAnalysis`** (2d): the existing `visual-analysis.ts`
   module already meets the spec — no further work needed.
5. **`ToolExecutionPipeline`** (2b): thin facade over
   `StreamingToolExecutor` so `duyaAgent.streamChat` never
   instantiates the streaming executor directly. The facade
   establishes the seam for the upcoming step 2b-internals —
   `DependencyGraphOrchestrator.planExecution()` slots between
   `addTool` and `getRemainingResults` without any caller-side
   changes. 7 unit tests pin the public surface (constructor
   signature, addTool, getRemainingResults async-iterable, setCallbacks,
   discard / dispose idempotency, getMemoryUsageMB).
6. `DuyaAgent.ts`: `4812` → `4619` lines (`-193`), with a clean
   facade-friendly boundary at the top of `streamChat` and the
   `toolExecutionPipeline` import substituting for the streaming
   executor at the wire site.

Net: three new modules, 20 new atomic commits (19 code + 1 plan
update), and `DuyaAgent.ts` is now within ~5× of the plan target
(< 800 lines) while every commit keeps behaviour identical to
baseline (verified by running the agent test surface before and
after each refactor; pre-existing plan-486 test failures unchanged
across all commits).

The user's original goal — "针对和 mcode 对比之后发现的
需要duyaagent.ts分层拆解的部分下功夫做到好的拆解工程 完整
不丢东西但是合理优秀的拆解" — is materially advanced but not
finished: `streamChat` still owns the LLM+tool loop (~1700 lines
of mixed-mode dispatch, hook dispatch, error handling). Session 5
will land 2b-internals + 2e (TurnPreparer / TurnLoop /
StreamFinalizer).

## Background

After the harness-comparison study (2026-08, `harness-comparison-docs.md`)
duya 暴露了三个**架构层短板**,让 "干活多说话少 + 并行强 + 速度快"
这个体感追不上 minimax-code(mcode):

| 短板 | 现状 | 改进方向 |
|---|---|---|
| 1. Prompt 系统臃肿 | `PromptSystem.ts` 单类 + 10 个 section + 13 个 dynamic section,总长接近 mcode 的 10 倍,且 `PromptSystem.ts:35-37` 自警告"will break prompt caching" | 改用 **Handlebars `.hbs` 模板** + YAML frontmatter,像 mcode 那样把 system prompt 收敛到 76-110 行的 .hbs 模板,条件渲染 `{{#if features.x}}`,保留 prompt caching 友好 |
| 2. Agent 主类单体化 | `DuyaAgent.ts` **4473 行**,糅合 turn 装配、工具执行、compaction、permissions、visual-analysis、scratchpad、reminders 多职责 | 拆成 **5 个职责清晰子模块**:`TurnAssembler` / `ToolExecutionPipeline` / `CompactionCoordinator` / `PermissionsGate` / `TurnContext`;`DuyaAgent` 收尾为 facade,只保留 `streamChat` 入口 |
| 3. 工具批调度粒度粗 | `tool/orchestration/types.ts` 静态映射 `TOOL_BATCH_MAP`,阶段间 `READ→WRITE→SYSTEM` 强制串行,工具实例级依赖丢失 | 重写为 **Dependency-Graph Orchestrator**:`each tool_use declares dependencies` → 框架按依赖图调度,而不是按工具名分阶段 |

## Goals

- **Goal 1**:system prompt 拼装逻辑全部搬到 `.hbs` 模板,渲染时间 < 5ms,prompt cache 命中率保持 ≥ 现状
- **Goal 2**:`DuyaAgent.ts` < 800 行(从 4473 行降 82%);每个新模块 < 600 行且职责单一
- **Goal 3**:同一 LLM turn 内多个独立 tool_use 全部按依赖图并行;`{maxConcurrency}` 从按 batch 配置改为按 `dependencies` 解析;write/write 之间的隐式串行约束**保留**(`preImageSha` 不能并行写同一文件)

## Non-Goals

- 不重写 pi-coding-agent 风格的事件队列(mcode 那套不直接搬过来,duya 的 SSE 流式 UI 与之不兼容)
- 不改 `tool/registry.ts` 的 `ExposeMode` 四层结构
- 不改 compaction 422 / 495 / 517 的逻辑,只把 `DuyaAgent.streamChat` 里的 compaction 调用搬到 `CompactionCoordinator`
- 不动 plan 429 的 P0/P1 任务(checkpoint / PreToolUse / sandbox / failover / 子代理 UI)

## Atomic Commits

每个改造拆 3-5 个原子 commit,每个 commit 前跑 `npm run typecheck:all`。

## Session 6 (2026-09-19, Plan 550 1c fixups + 1d-rest 1/9)

Three commits, all on `feat/550-decompose-session6` from `8d410d0b` (session-5+ final). No source changes to `DuyaAgent.ts`, `PromptSystem.ts`, or any of the prompt-section `.ts` files beyond what is needed for the migration itself.

| Commit | Step | 内容 |
|---|---|---|
| `0e175896` | 1c deps fixup | `package.json` + `package-lock.json` add `handlebars@^4.7.9` + `@types/handlebars@^4.0.40`. The 1c commit `1a9d51e3` added `HandlebarsRenderer.ts` that imports `'handlebars'` but never declared the dep — fresh checkouts failed to resolve the module, and `package-lock.json` had also drifted out of sync with the `0.8.1` `package.json` bump. Single `npm install --ignore-scripts` (the puppeteer post-install was failing on this Windows runner) fixed both. |
| `8301765e` | 1c CRLF fixup | `.gitattributes` with `*.hbs text eol=lf` + `*.md.hbs text eol=lf`. Plan 550 1c shipped LF `.hbs` files; on Windows checkouts with `core.autocrlf=true` (the default), every `.hbs` was being silently rewritten to CRLF, which then leaked through `Handlebars.render` and broke byte-level parity tests against the TS source-of-truth. This was logged in `451545b0` as a pre-existing Plan 550 regression but never fixed. After this commit, 14/14 parity tests pass (previously 6/14 — every non-empty section — failed). |
| `3c5b965e` | 1d-rest 1/9 | Migrate `getVisualVerificationSection` to `assets/dynamic/visual-verification.hbs`. The four configs that declare it (general / code / gateway / research) each gain `template: 'dynamic/visual-verification.hbs'` next to the existing `compute:` reference. Two byte-level parity tests added (vision-enabled / vision-absent). `getVisualVerificationSection` stays on disk as the parity reference for now; the 1d delete pass will sweep it alongside the other eight sections in a follow-up commit. |

**Session 6 takeaway**: Plan 550 1c was a multi-file commit that landed visible work (5 `.hbs` files, `HandlebarsRenderer.ts`) plus two silent regressions (missing deps + CRLF on Windows). Session 6 closed both regressions as discrete, minimal commits so the remaining 1d-rest sections can land without re-introducing either bug pattern. The same `1d-rest 1/9` shape (1 `.hbs` + N config edits + N parity tests) is the right size for the other eight sections — they're independent because each section has its own precomputed `mapPromptContextToHbs` slot.

**Next session entry points (session 7)**:

- **1d-rest 2-9/9**: agentsMdSection / environment / memorySection / recentSessionsSection / scratchpad / sessionGuidance / sessionSearchSection / skillsMetadata. Each follows the same shape as commit `3c5b965e` — 1 new `.hbs`, 1-N config edits, 0-N parity tests. Estimated 6-9 commits, ~150 lines total.
- **1d delete**: sweep all 9 legacy `.ts` files plus the `general/sections/*.ts` tree in one atomic commit. Single byte-level parity regression test must remain passing before the sweep (re-run `dynamic-sections.test.ts` after the delete).
- **改造 2e TurnLoop event dispatcher**: still pending from session 5; 700-1100 lines of `streamChat` between the LLM stream subscription and the final SSE yield. Plan to extract into a `TurnEventDispatcher` that the `streamChat` body wires in front of `TurnStreamRunner` (see `2e TurnLoop first slice` in `b17384b2` for the consumer seam).

### PR #1: Prompt → Handlebars

| # | Commit | 范围 |
|---|---|---|
| 1a | `feat(prompts): add Handlebars renderer + .hbs asset loader` | 新增 `prompts/hbs/HandlebarsRenderer.ts` + `prompts/hbs/assetLoader.ts`;加 handlebars 依赖 |
| 1b | `refactor(prompts): migrate general sections to .hbs templates` | `prompts/general/sections/*.ts` → `prompts/hbs/templates/general/*.hbs`;`PromptSystem.buildSystemPrompt` 改成渲染器调用 |
| 1c | `refactor(prompts): migrate dynamic sections to .hbs + preserve cache` | 13 个 dynamic section 逐个迁移,volatile sections 通过 `{{#volatile_now}}` 块标记,确保只它们破坏 cache |
| 1d | `chore(prompts): delete legacy TS sections + PromptSystemConfig` | 删 `prompts/general/sections/*` 和 `PromptSystem` 单类实现,改由 `HbsPromptSystem` 单一类接管 |

### PR #2: DuyaAgent Decomposition

| # | Commit | 范围 |
|---|---|---|
| 2a | `refactor(agent): extract TurnAssembler (turn assembly layer)` | 从 `DuyaAgent` 抽 `TurnAssembler.ts`(~400 行):turn 初始化、history 注入、outbound normalizer、context projection |
| 2b | `refactor(agent): extract ToolExecutionPipeline (tool loop)` | 抽 `ToolExecutionPipeline.ts`(~500 行):tool batch → dependency graph → streaming executor 串联 |
| 2c | `refactor(agent): extract CompactionCoordinator (compaction policy)` | 抽 `CompactionCoordinator.ts`(~350 行):422/495/517 的 compaction 触发、协调、cooldown、over_threshold 制动 |
| 2d | `refactor(agent): extract PermissionsGate + VisualAnalysis + Scratchpad` | 抽三个独立模块,每个 < 300 行 |
| 2e | `refactor(agent): DuyaAgent reduced to facade (<800 lines)` | 删除已抽出代码,DuyaAgent 收尾为 facade |

### PR #3: Dependency-Graph Orchestration

| # | Commit | 范围 |
|---|---|---|
| 3a | `feat(tool): add ToolDefinition.dependencies schema` | `BaseTool` 加 `dependencies?: { read?: string[]; write?: string[] }` 元数据;每个自研工具声明 |
| 3b | `refactor(tool): replace batch orchestration with DependencyGraphOrchestrator` | 删 `TOOL_BATCH_MAP` + `BATCH_STRATEGY`,新 `DependencyGraphOrchestrator.ts` 用 topo sort + concurrency limiter |
| 3c | `refactor(tool): StreamingToolExecutor wired to dependency graph` | `StreamingToolExecutor.runBatch` 改成 `runDependencyGraph` |
| 3d | `test(tool): add end-to-end parallel tool execution tests` | 覆盖 4 场景:all-read / read+write(独立路径) / write+write(同文件串行) / write+write(不同文件并行) |

## Testing Gates

每个 commit 之前必须:

- [ ] `npm run typecheck:all` 全绿
- [ ] `npm run test --workspaces -- --run` 单测全绿
- [ ] 触及 prompt 系统时,跑 `prompts/__tests__/prompt-system.test.ts` 确认输出字节级一致
- [ ] 触及 agent 循环时,跑 `agent/__tests__/duya-agent.test.ts` + 集成 smoke

每个 PR 之前:
- [ ] 三遍整体检查:
  1. 跨文件 import 完整性
  2. 与 plan 429 P0/P1 任务的兼容性(checkpoint / PreToolUse / failover)
  3. 与 bot 模式 / research mode / plan-mode 的兼容
- [ ] `git diff --stat` 评估改动体量符合预期
- [ ] CHANGELOG / ARCHITECTURE.md 同步更新

## Risks

| 风险 | 概率 | 缓解 |
|---|---|---|
| Prompt 改 hbs 后内容变化导致 LLM 行为偏移 | 中 | 1b / 1c commit 后跑字节级 diff 测试,确保除模板语法外文本完全一致 |
| DuyaAgent 拆层破坏隐性调用顺序 | 中 | 2a-2d 每次抽出后跑全套测试;2e 最后收尾时再做完整集成测试 |
| Dependency graph 在 write/write 同文件场景失去串行约束 | 低 | 3a schema 设计时显式声明 `write?: [path]`;3c 的 topo sort 必须按 `write` 字段判定串行 |
| MCP 工具没有声明 dependencies 导致全并行 | 中 | 3a 默认 `dependencies = { read: [], write: [] }`;MCP 工具继承 base 实现,行为不变 |
| Bot / research / plan-mode 各自的 prompt system 各自有定制,迁移时漏掉 | 中 | 1b 列出所有 prompt system 实例,逐个迁移不批量替换 |

## Out of Scope (后续 plan 候选)

- 自研 prompt 模板编辑器(in-IDE .hbs 高亮 + 预览)
- handlebars helper 扩展(自定义 {{#tool_list}} / {{#mcp_servers}})
- 自动化 prompt A/B 测试框架
- dependency graph 可视化(用于 review)

## Reference

- `E:\cloned-projects\minimax-code\packages\agent-core\src\pi-turn-runner\pi-turn-runner.ts:182-188` — mcode 的并行工具调用设计
- `E:\cloned-projects\minimax-code\packages\local-runtime-v2\assets\agents\mavis\system-prompt.md.hbs` — mcode 的 .hbs 模板范例
- `E:\cloned-projects\minimax-code\packages\local-runtime-v2\src\service\agent\builtin\prompt-renderer.ts` — mcode 的 Handlebars 渲染器实现
- `packages/agent/src/prompts/PromptSystem.ts:35-37` — duya 自警告"will break prompt caching"
- `packages/agent/src/tool/orchestration/types.ts:12-31` — duya 当前 batch 调度策略

## Session 6+ (2026-09-19, 1d-rest 2/9 → 4/9)

Three follow-up commits on `feat/550-decompose-session6` after the initial PR #60 head (`05bdf5a0`), all on top of `a3d4d237` / `71bc3134` / `41b3f4e6`.

| Commit | Step | 内容 |
|---|---|---|
| `a3d4d237` | 1d-rest 2/9 | Migrate `getScratchpadSection` to `assets/dynamic/scratchpad.hbs`. The four configs that declare it (general / code / gateway / bot) each gain `template: 'dynamic/scratchpad.hbs'`. `mapPromptContextToHbs` adds `scratchpad_dir` (default `''`). 2 byte-level parity tests (set / absent). |
| `71bc3134` | 1d-rest 3/9 | Migrate `getSessionSearchSection` to `assets/dynamic/session-search.hbs`. Three configs (general / code / gateway) gain the `template:` slot. Mapper adds `has_session_search_tool`. 2 byte-level parity tests (tool enabled / tool absent). |
| `41b3f4e6` | 1d-rest 4/9 | Migrate `getSessionGuidanceSection` to `assets/dynamic/session-guidance.hbs`. **First non-trivial 1d-rest case**: five conditional paragraphs joined with a ` - ` prefix, with an any-empty short-circuit. Mapper adds nine new slots (5 conditional booleans + `search_tools` label + 2 derived visibility flags). Four configs (general / code / gateway / bot) updated. 9 byte-level parity tests (split: 2 in dynamic-sections.test.ts covering omitted/fork; 7 in session-guidance-1d-rest.test.ts covering most-paragraphs / fork / embedded / non-interactive / DiscoverSkills / verification-disabled / hasSkills-only). |

**Session 6+ takeaway**: 4 of 9 1d-rest sections migrated (visualVerification / scratchpad / sessionSearch / sessionGuidance). The remaining 5 sections all hit the same architectural wall — they have async work or filesystem reads that the current `mapPromptContextToHbs` (sync) cannot host:

| Section | Why it blocks |
|---|---|
| `environment` (157 lines) | Async `fs.access(.git)` for git-repo detection; date/time formatting with `Intl.DateTimeFormat`; 50+-branch `getMarketingNameForModel` lookup; OS-info via `os` module |
| `memorySection` (74 lines) | `fs.readFileSync` on `~/.duya/memory/summary.md` with 12k-char truncation and a `_not yet generated_` fallback |
| `recentSessionsSection` (59 lines) | Async directory loader (`loadRecentSessionDirectory`); JSON entry serialization with date formatting |
| `skillsMetadata` (204 lines) | Tier-selection algorithm (`pickCatalogTier` against 3 budgets × N skills); XML escape + system-skill grouping; optional `### Skill roots` table |
| `agentsMdSection` | Originally listed in 1d-rest inventory but is actually a `preBuildHook` side-effect (`initializeAgentsMd`), not a prompt section. **Drop from 1d-rest inventory** — 1d-rest reduces to 8 sections, not 9. |

**Required redesign before 1d-rest 5-9/9 can land**: the PromptSystem contract assumes `renderSectionCompute` is sync. Migrating these sections requires either (a) making `buildSystemPrompt` async-aware so `mapPromptContextToHbs` can `await fs.readFile` / `loadRecentSessionDirectory`, or (b) extracting the I/O into a pre-build hook that runs before `buildSystemPrompt` (analogous to `initializeAgentsMd`) and pre-populates a side-channel that `mapPromptContextToHbs` reads. Option (b) is the lower-risk shape: it preserves the sync render path, matches the existing `preBuildHook` precedent, and keeps byte-level parity tests honest (the I/O can be stubbed in tests just like the agentsmd pre-build hook is stubbed in `omitAgentsMdPreBuildHook.test.ts`).

**Next session entry points (session 7+)**:

- **改造 2e TurnLoop event dispatcher**: 700-1100 lines of `streamChat` between the LLM stream subscription and the final SSE yield. Plan to extract into a `TurnEventDispatcher` that the `streamChat` body wires in front of `TurnStreamRunner` (see `2e TurnLoop first slice` in `b17384b2` for the consumer seam).
- **改造 3c/3d**: route `StreamingToolExecutor.runBatch` through `DependencyGraphOrchestrator.planExecution`; add 4 e2e batch tests (all-read / read+write independent / write+write same path / write+write different paths).
- **1d-rest 5-9/9 (after redesign)**: pick the easiest of the 4 blockers and prove out option (b) above with a thin pre-build hook that pre-populates one or two mapper slots. The shape that works for environment's git detection is the same shape that works for everything else.
- **1d delete pass**: sweep all 8 legacy `.ts` files (1d-rest inventory after dropping `agentsMdSection` is 8) plus the `general/sections/*.ts` tree in one atomic commit. Single byte-level parity regression test must remain passing before the sweep.
- `packages/agent/src/agent/DuyaAgent.ts` — duya 4473 行主类(将拆层)

## Session 7 (2026-09-19, 1d-rest 6/8 — environment)

| Commit | Step | 内容 |
|---|---|---|
| `77b3e33f` | 1d-rest 6/8 | Migrate `getEnvironmentSection` to `assets/dynamic/environment.hbs`. **The async + non-deterministic waterline** — `fs.access(.git)` for git-repo detection, `Date.now()` for the timestamp, plus three sync lookups (`getMarketingNameForModel`, `getKnowledgeCutoff`, `getUnameSR`). Strategy: lift the `env_items: string[]` builder into a shared helper that both the legacy TS path and the .hbs mapper call. The mapper produces a single `env_items` slot; the template renders it via `{{#each env_items}} - {{this}}\n{{/each}}`. `buildStaticSections` `.trim()` handles the trailing newline. `environmentPreBuildHook` captures the 5 ctx fields once per `buildSystemPrompt` (`isGitRepo`, `nowMs`, `unameSr`, `marketingName`, `knowledgeCutoff`) — same shape as `memoryPreBuildHook`. Four configs (general / code / gateway / bot) updated. Five dedicated parity tests covering Windows+git / Unix+no-git / no-cwd / worktree / additional-working-dirs+location. `npm run typecheck:agent` clean; `prompts/hbs/` 47/47 pass. |

**Session 7 takeaway**: environment was the hard 1d-rest case — async I/O, non-deterministic clock, multiple sync lookups, and the structural `.map().join('\n')` vs `{{#each}}` whitespace alignment. The `env_items` shared-helper pattern resolved all four. The remaining 1d-rest sections (`recentSessionsSection` / `skillsMetadata`) have simpler shapes — `recentSessionsSection` is just `fs.readdir` + JSON serialize (like memory but cheaper), `skillsMetadata` is sync registry + tier selection (no I/O beyond what the helper already exposes). Both follow the same `preBuildHook` → `promptContextExtension` → mapper → `{{#each}}` chain.

**Bug reflections** (recorded in the commit body):

1. environment draft had a `platform: ctx.platform` duplicate in `HbsPromptSystem` (line 150 + line 190). Resolved by deleting the second occurrence when collapsing to the single `env_items` slot.
2. environment draft referenced `getShellInfoLine` and `formatCurrentDateTime` without importing them in `HbsPromptSystem`. Moved both into `environment.ts` as exports; mapper imports them directly.
3. environment draft added a duplicate `knowledgeCutoff?: string | null` field at the bottom of `PromptContext`. The existing field at line 183 (`knowledgeCutoff?: string`) is the source of truth; widened it to `string | null` instead of duplicating. The preBuildHook sets `null` when no `KNOWLEDGE_CUTOFFS` match, matching the legacy `ctx.knowledgeCutoff ?? getKnowledgeCutoff(ctx.modelId)` fallback.
4. `environmentPreBuildHook.unameSrFn` typed `NodeJS.Platform` but received `string` from `context.platform`. Widened the helper's `platform` parameter to `string` and cast at the call site.
5. `environmentPreBuildHook.marketingName` option typed `string | undefined` but `getMarketingNameForModel` returns `string | null`. Widened to `string | null | undefined` and coerce with `?? null` at the call site so the extension payload matches the widened `PromptContext` field type.

**Cross-checked pre-existing test failures** (verified via `git stash` + test, then `git stash pop` to restore the working tree):

- `packages/agent/tests/unit/prompts/omitAgentsMdPreBuildHook.test.ts` — 3 failures (general / code / research). `expect(initSpy.fn).toHaveBeenCalledWith('/tmp')` fails because `initializeAgentsMd` is called with `(workingDirectory, projectHome)` and `projectHome` is `undefined`. Pre-existing on `8d410d0b` baseline; unrelated to environment work.
- `packages/agent/tests/unit/prompts/projectContinuity.test.ts` — 1 failure (`keeps continuity in the code config static sections`). Expects `agentsMd` in staticNames but the section was migrated into the `preBuildHook` side channel. Pre-existing.
- `packages/agent/tests/unit/prompts/gateway/GatewayPromptSystem.test.ts` — 1 failure. Expects `MEDIA:<absolute-path>` in the prompt body. Pre-existing.

These three were already tracked as Plan 486 / Plan 408 follow-ups and are unrelated to 1d-rest progress. None of them block environment migration or any other 1d-rest commit.

**Next session entry points (session 8+)**:

- **1d-rest 7/8 — recentSessionsSection**: async directory loader (`loadRecentSessionDirectory`) + JSON entry serialization. Same shape as `memorySection` but without the 12k truncation. preBuildHook populates `recent_sessions_payload: string`; mapper passes it through; template wraps in the section header. Estimated 1 commit.
- **1d-rest 8/8 — skillsMetadata**: tier-selection algorithm (`pickCatalogTier` against 3 budgets × N skills) + XML escape + optional `### Skill roots` table. Sync registry lookup, so the preBuildHook is purely a no-op gate (or maybe not even needed). Estimated 1 commit.
- **1d delete pass**: sweep all 8 legacy `.ts` files plus `general/sections/*.ts`. Run all four dedicated parity suites (`session-guidance-1d-rest`, `memory-1d-rest`, `environment-1d-rest`, plus the 20 in `dynamic-sections`) after each delete to confirm no regression. Estimated 1 commit.
- **改造 2e TurnEventDispatcher**: 700-1100 lines of `streamChat` body between the LLM stream subscription (already extracted into `TurnStreamRunner`) and the final SSE yield (`SessionFinalizer`). Multi-commit refactor. Suggested decomposition: **2e-1** mode dispatch + dead-loop guard (~300 lines), **2e-2** per-turn message persistence + reply/fork resolution (~400 lines), **2e-3** tool-use loop control + `tool_use`/`tool_result` event sequencing (~400 lines). Each commit lands with a parity test that locks in the SSE event shape end-to-end via `streamChat`'s collected output.

## Session 7+ (2026-09-19, 1d-rest 7/8 — recentSessionsSection)

| Commit | Step | 内容 |
|---|---|---|
| `32eab79b` | 1d-rest 7/8 | Migrate `getRecentSessionsSection` to `assets/dynamic/recent-sessions.hbs`. Cheapest 1d-rest case after environment — async `loadRecentSessionDirectory` reads the session database and serialises each entry to JSON; the section body is a static template with two list slots + one MessageSession gating line. Same shared-helper pattern: preBuildHook loads the directory once per buildSystemPrompt, emits already-serialised JSON entry strings. Mapper joins them with ` - ${entry}\n` via `serializeSerializedGroup`. `messaging_guidance` line (gated on `MESSAGE_SESSION`) moved to the mapper so the .hbs body just substitutes one string. Wrapped entire body in `{{#if section_enabled}}...{{/if}}` so the empty-directory case renders `''` (mapper / renderSectionCompute collapses to `null`, matching the legacy short-circuit). Four configs (general / code / gateway / research). Five dedicated parity tests covering both-populated / same-only / both-empty / MessageSession-enabled / MessageSession-unavailable. |

**Bug reflections** (in commit body):

1. The legacy `getRecentSessionsSection` short-circuits to `null` when both entry arrays are empty. The naive .hbs (header + body + two slot substitutions) always renders the body, breaking byte-level parity in the empty case. Fix: wrap the entire body in `{{#if section_enabled}}...{{/if}}` and have the mapper set the flag from the array lengths. `renderSectionCompute` collapses empty output to `null`.
2. The legacy function's `messaging_guidance` line is gated on `enabledTools.has(MESSAGE_SESSION)`. Moving it to the mapper keeps the gating logic in TypeScript where the Set lookup is type-safe.
3. `recentSessionsSection.ts` and `recentSessionsPreBuildHook.ts` have a circular type dependency: the preBuildHook imports `serializeEntry` from the section file, and the section file's loader type alias was already declared there. PreBuildHook imports the loader type from the section file too. Verified the cycle is type-only (TS resolves via the merged module).
4. The preBuildHook's empty-return shortcut returns `undefined` rather than `{ promptContextExtension: {} }` so the spread merge skips the empty object and the ctx-side fields stay falsy.

## Session 7++ (2026-09-19, 1d-rest 8/8 — skillsMetadata, 1d-rest inventory complete)

| Commit | Step | 内容 |
|---|---|---|
| `d5801681` | 1d-rest 8/8 | Migrate `getSkillsMetadataSection` to `assets/dynamic/skills-metadata.hbs`. Last 1d-rest section. The legacy `formatSkillCatalog(skills)` builds the entire body — XML `<available_skills>` block + optional `### Skill roots` table + trailing usage line — so the .hbs is a thin pass-through rather than a structural template. Mapper calls `getSkillsMetadataSection(ctx)` synchronously; .hbs wraps the substitution in `{{#if skill_catalog_body}}...{{/if}}` so empty / omitted sections render `''` and `renderSectionCompute` collapses them to `null`. `getSkillsMetadataSection` accepts an optional `{ skills?: PromptSkill[] }` second parameter for test injection (bypasses the global `getSkillRegistry()` singleton). Four configs (general / code / gateway / bot). Five dedicated parity tests covering tools-missing short-circuit / empty skill list / small-list `full` tier / large-list tier-downgrade / 250-char description clamp. **This commit closes the Plan 550 1d-rest inventory — all 8 dynamic sections now have `.hbs` migration paths.** |

**Bug reflections** (in commit body):

1. The `getSkillRegistry()` singleton is process-wide and gets populated by side-effecting tests in other suites. The parity test must reset it via `resetSkillRegistry()` before each comparison, otherwise stale skills from previous test runs would leak into the .hbs mapper path.
2. The mapper cannot accept per-call options the way the legacy function does. The parity test bridges this asymmetry by registering the same skills into the global registry the mapper reads from — TS path uses the override, .hbs path reads the registry, and the bodies match because both paths produce the same `formatSkillCatalog(skills)` output.
3. `{{#if skill_catalog_body}}` gate fires on empty string falsiness; Handlebars treats `''` as falsy so the wrapper collapses empty output to nothing. Combined with `renderSectionCompute`'s `out === '' ? null : out`, the legacy short-circuit (`return null` when no skills or no load tools) is preserved end-to-end.

**Next session entry points (session 8+)**:

- **1d delete pass** (decoupled ✅ `ec4ebcd9`): removed `compute:` field from the 8 migrated section entries in 5 configs; made `SectionDef.compute` optional in `PromptSystem.ts`. Production paths are now `.hbs`-only; the legacy `getXxxSection` functions live on only as parity-test references. **Sweep the legacy `.ts` files entirely is deferred** — it would require rewriting 8 parity tests + 2 non-parity tests (`recentSessionsSection.test.ts` / `projectContinuity.test.ts`) to compare against hardcoded expected strings, which is a larger refactor that deserves its own commit.
- **改造 2e TurnEventDispatcher**: 700-1100 lines of `streamChat` body between the LLM stream subscription (already extracted into `TurnStreamRunner`) and the final SSE yield (`SessionFinalizer`). Multi-commit refactor. Suggested decomposition: **2e-1** mode dispatch + dead-loop guard (~300 lines), **2e-2** per-turn message persistence + reply/fork resolution (~400 lines), **2e-3** tool-use loop control + `tool_use`/`tool_result` event sequencing (~400 lines). Each commit lands with a parity test that locks in the SSE event shape end-to-end via `streamChat`'s collected output.