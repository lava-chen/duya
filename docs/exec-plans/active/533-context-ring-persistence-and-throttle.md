# Plan 445: Context Ring Persistence & Live-SSE Field Plumbing

## Context

Plan 443 established the stateless pure estimator (`computeContextEstimate`)
and plan 444 added per-event journal persistence plus the
`usage ?? tokenUsage.last_call` anchor preference. Audit of the on-disk
code (post-plan-444) found 4 separate bugs that all defeat the ring
math end-to-end. This plan closes them.

## Bugs fixed

### Bug #1 · `last_call` never persisted (high)

`Journal.fire` (Journal.ts:196) reads `source.tokenUsage` (camelCase).
`DuyaAgent.ts:2179-2187` set it to `usageBlock` (single largest call,
no `last_call`). The cumulative `tokenUsage` + `last_call` lived in
`agent-process-entry.ts:2892-2960` scope and was attached to
`lastAssistant.token_usage` (snake_case) **AFTER** the stream loop ended —
but journal had already fired by then, so the row in the DB carried only
the single-call block. On reload, `normalizePromptTokens` (which prefers
`last_call`) fell back to `raw` — the cumulative sum inflated the
persisted anchor ~N× on tool-heavy turns.

**Fix**: lift the cumulative into `cumulativeTokenUsageRef` (mutable
reference on `ChatOptions`). `DuyaAgent.ts` reads it at the `done`
boundary BEFORE `_pushDurable` runs journal. Legacy `usageBlock` path
remains as fallback for CLI / unit tests.

### Bug #2 · SSE handler stripped 8/11 fields (high)

`agent-sse-client.ts:393-402` mapped the worker's `token_usage` frame
into a slim 6-field subset before dispatching. The downstream
`applyWorkerUsageSnapshot` saw all missing fields as undefined, defaulted
them, and `useContextUsage.ts:262` rejected the frame
(`anchored=false`) — falling back to the persisted scan. Live ring
accumulation was effectively dead.

**Fix**: pass `eventObj` through verbatim. The downstream types already
accept the full `WorkerUsageSnapshot`.

### Bug #3 · Persisted tokenUsage was single-call, not cumulative (medium)

Tied to Bug #1: even without `last_call`, the row stored only the
largest single call instead of the per-turn sum. Scan over multiple
assistant rows gave the right answer (sum of all single-calls ≈ sum of
all calls = total session tokens), but the dashboard
`usage-aggregator.ts` and the persistent anchor both depended on a single
row's `input_tokens` being authoritative — which it wasn't.

**Fix**: same as Bug #1. `pushed.tokenUsage` is now the cumulative block
on every `done` boundary.

### Bug #4 · Seeding loop dead snake_case fallback (low)

`agent-process-entry.ts:2686-2690` read both `m.tokenUsage` and
`m.token_usage`. The snake_case variant was written by a turn-end code
path that is now removed (the `tokenUsage` block is attached via the
cumulative ref before journal). Dead branch — cleaned up.

### Bug #7 · `tool_result` emit spam (low)

`emitTokenUsage()` was called on every `tool_result` event. With the
SSE field plumbing fixed (Bug #2), each call would push a duplicate
zustand set → React re-render. Throttle: keep `lastEmittedUsageKey`
string cache; skip `sendToMain` when the diff key is unchanged.

## Files changed

- `packages/ai/src/types.ts` — add `last_call?: {...}` sub-block to `TokenUsage`
- `packages/agent/src/types.ts` — add `cumulativeTokenUsageRef?: { current: TokenUsage | null }` to `ChatOptions`
- `packages/agent/src/agent/DuyaAgent.ts` — read `cumulativeTokenUsageRef` at done boundary, fall back to `usageBlock`
- `packages/agent/src/process/agent-process-entry.ts`:
  - Lift `tokenUsage` / `lastCallUsage` / `lastCallModel` / `lastCallProviderId` above `streamChat` call
  - Create `cumulativeTokenUsageRef` mutable and pass through streamChat options
  - Update `cumulativeTokenUsageRef.current` after every `result` event with `{...tokenUsage, last_call}` shape
  - Drop dead in-process `token_usage` write at end of stream loop (was masked by INSERT OR IGNORE dedup)
  - Drop dead snake_case fallback in seeding loop
  - Add `lastEmittedUsageKey` dedupe cache around `sendToMain`
- `src/lib/agent-sse-client.ts` — pass `eventObj` through to downstream (was stripping 8 fields)
- `packages/agent/src/journal/__tests__/journal-plan445.test.ts` — new regression tests

## Verification

- `npx tsc --noEmit -p packages/agent/tsconfig.json` — clean
- `npx vitest run packages/agent/src/journal` — 20/20 pass (3 new + 17 existing)
- `npx vitest run electron/ipc/__tests__/core-db-adapters.test.ts` — 22/22 pass
- `npx vitest run packages/agent/src/process` — 26/26 pass

Pre-existing test failures (NOT related to this plan):
- `electron/ipc/__tests__/db-handlers.test.ts` (1 failure)
- `electron/ipc/__tests__/app-connection-handlers.test.ts` (2 failures)

Verified by stashing this plan's changes and re-running — the same
failures reproduce on clean master.
