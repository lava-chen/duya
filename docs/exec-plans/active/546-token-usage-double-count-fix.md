# Plan 546: Fix Token Usage Double-Count and Cumulative Pollution

> **Status**: ready to execute (2026-09-14)
> **Priority**: P0
> **Discovered by**: post-plan-445 audit; user reports ring numbers ~10× off
> (e.g. 1.0M used / 1063.7% with 1720M cumulative input on a long session)

## Problem

Plan 445 (`c7d2aa6d fix(agent): persist cumulative tokenUsage + last_call,
plumb SSE fields`) correctly lifted the per-turn cumulative tokenUsage into
`pushed.tokenUsage` BEFORE journal fires, so the persisted DB row carries
the right shape. But it regressed three things in the same change:

1. **Seed loop double-counts every multi-call turn.**
   `packages/agent/src/process/agent-process-entry.ts:2694-2731` iterates
   over `agent.getMessages()` and sums `m.tokenUsage.input_tokens` plus
   cache fields for every assistant message. After plan 445, those
   `tokenUsage.input_tokens` are **per-turn cumulative** (sum of every LLM
   call in that turn). On the SAME turn, the `result` event handler
   accumulates the per-call `rawInput` into `liveTotalInput` again — so a
   3-call turn is counted twice. Over N turns the gap grows ~N×, producing
   the 1720M / 1.0M numbers in the screenshot.

2. **`pushed.usage` was rewritten to the cumulative block.**
   `packages/agent/src/agent/DuyaAgent.ts:2185` sets `pushed.usage =
   cumulative` (alongside `pushed.tokenUsage = cumulative`). The in-memory
   `usage` field is the anchor `computeContextEstimate.isUsableAnchor`
   reads first (it prefers `usage` over `tokenUsage`). When `last_call` is
   present, `normalizePromptTokens` prefers `last_call` so the anchor
   value is still right, but `usage = cumulative` leaks the per-turn sum
   into every other consumer that doesn't re-apply the last_call
   preference (the seed loop above is the worst offender).

3. **Dedupe key missing `liveTotalInputRaw`.**
   `agent-process-entry.ts:438` builds the SSE frame dedupe key from
   `usedForRing + anchored + liveTotalInput + liveTotalCacheHit +
   liveTotalCacheCreation + liveTotalOutput + model + providerId`. When
   `totalInputRaw` changes between consecutive `result` events but the
   cached (post-normalize) inputs are unchanged, the key still changes
   whenever the cache counters tick — emitting redundant frames.

## Fix

Single small commit on master:

### A. Seed loop: anchor the cumulative correctly

Replace the seed loop body to sum PER-CALL fields, not per-turn
cumulative. The persisted row carries a `calls[]` ledger when plan 445
is in effect, plus a `last_call` snapshot. The cleanest source of truth
is: **if `calls[]` exists, sum `calls[i].input_tokens` (+ cache
fields); otherwise fall back to `last_call`; otherwise (legacy single-
call row) use the top-level fields directly**.

This matches what the agent loop's `result` handler actually sums, so
seed + result no longer double-count.

### B. `pushed.usage` back to the single-call block

`pushed.usage` is the in-memory anchor (pi style). It should be the
single-call snapshot (largest-prompt `last_call` if available, else
the legacy `usageBlock`). `pushed.tokenUsage` stays cumulative for the
DB column. This keeps every existing consumer of `usage` working
without them needing to know about `last_call`.

### C. Dedupe key

Add `liveTotalInputRaw` to the dedupe key string. Cheap and stops the
cache-tick emit spam.

## Files

- Modify: `packages/agent/src/process/agent-process-entry.ts`
  - seed loop (lines 2694-2731)
  - emitKey (line 438)
- Modify: `packages/agent/src/agent/DuyaAgent.ts`
  - done-boundary push (lines 2179-2204)
- Create: `packages/agent/src/process/__tests__/seed-token-usage-plan546.test.ts`
  - regression test for the seed loop
- Create: `packages/agent/src/agent/__tests__/duya-agent-usage-plan546.test.ts`
  - regression test for `pushed.usage` shape

## Verification

- `NODE_OPTIONS=--max-old-space-size=6144 npx tsc -p packages/agent --noEmit`
- `npx vitest run packages/agent/src/process/__tests__/seed-token-usage-plan546.test.ts`
- `npx vitest run packages/agent/src/agent/__tests__/duya-agent-usage-plan546.test.ts`
- `npx vitest run packages/agent/src/journal/__tests__/journal-plan445.test.ts`
- `npx vitest run packages/ai`
