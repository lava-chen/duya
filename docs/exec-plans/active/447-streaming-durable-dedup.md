# Plan 447: Streaming vs durable transcript dedup on session switch-back

## Problem

Switching back to an in-flight session renders the current turn twice:

1. **Durable rows** — plan 441 journal persists user / assistant / tool-result
   rows to the rollout JSONL + SQLite **mid-turn** (`DuyaAgent._pushDurable`).
   `setActiveThread` always force-reloads the DB transcript
   (`conversation-store.ts` → `loadThreadMessages(id, { force: true })`), so
   completed rounds appear as durable message rows.
2. **Event-stream cache** — `StreamSessionManager` (global singleton keyed by
   sessionId) still holds **all** `streamingEvents` since turn start;
   `MessageList` mounts `StreamingMessage` while `isStreaming`, replaying the
   whole run below the durable rows.

Existing dedup (`registerLoadedMessages`) only registers tool ids and only
filters *future* SSE events; accumulated snapshot events are not purged, and
text/thinking have no ids at all. The attach path
(`attachToExistingStream`, Last-Event-ID 0 full replay) duplicates the same way
against the DB transcript.

## Approach (option B — reconcile against durable rows)

Render-layer projection instead of mutating manager state: subtract the
durable-covered prefix from `streamingEvents` before building streaming
actions. Works uniformly for switch-back, attach replay, and late DB loads.

Ordering invariant: journal persistence follows event arrival order, so
durable-covered events form a **prefix** of the streaming timeline ending at
the last durable `tool_result`. Text/thinking have no ids but sit inside that
prefix, so cutting at the last durable `tool_result` removes exactly the
finalized rounds and keeps the live tail (unfinalized text/thinking, running
tools).

Known limitation: a finalized text-only assistant block with no tool round in
the same turn cannot be cut (no durable marker) — mid-turn finalization always
contains a `tool_use` today, so this does not occur in practice.

## Phases

### Phase 1 — pure helper + unit tests

- [x] New `src/lib/durable-stream-subtraction.ts`:
  - `extractDurableToolIds(messages)` → `{ toolUseIds, toolResultIds }`
    (assistant content blocks `type: 'tool_use'`; `role: 'tool'` rows via
    `parentToolCallId ?? tool_call_id`).
  - `subtractDurableStreamingEvents(events, durable)` → drop the prefix up to
    and including the last durable `tool_result`; additionally drop any stray
    durable `tool_use` / `tool_result` events after the cut.
- [x] Colocated tests `src/lib/durable-stream-subtraction.test.ts`.

### Phase 2 — wire into rendering

- [x] `useStreamingActions`: read `messages[sessionId]` from
      `useConversationStore`, derive durable ids, apply
      `subtractDurableStreamingEvents` at rAF flush time (via ref so no
      subscription churn); re-flush when durable ids change (DB reload lands
      after events already flushed).
- [x] `stream-session-manager.handleToolResultEvent`: skip unconditionally when
      `loadedToolResultIds.has(id)` (previous guard required the result to
      already exist in state, letting a replayed durable result re-enter).

### Phase 3 — verification

- [x] `npx vitest run src/lib/durable-stream-subtraction.test.ts src/lib/stream-session-manager.test.ts` passes.
- [x] `npm run typecheck:web` passes.
- [ ] Manual: switch away and back to a streaming session — each completed
      round appears once; live tail keeps typing. Same for attaching to an
      external (cron) run mid-flight.

## Verification notes

- Pre-existing failures (unrelated, confirmed via git stash):
  `src/hooks/usePanel.test.ts` resolvePanelWidth × 2.
- Full `npm run test` blocked at pretest: better-sqlite3 ABI swap needs the
  `.node` file unlocked (Electron running). Targeted vitest runs used instead.

## Decision log

- Render-time subtraction over purging manager state: covers the attach/replay
  path automatically and avoids mutating shared singleton state mid-stream.
- Cut marker is the last durable `tool_result` (id-based, exact) rather than
  content matching for text/thinking (fragile).
