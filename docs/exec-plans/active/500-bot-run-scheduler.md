# Plan 500 — Bot Run Scheduler (grok SandRunScheduler parity)

> **Status**: Implementation (2026-09-06) **Priority**: High **Owner**: TBD

## Goal

Give `bot:<agentId>` sessions the same run scheduling model as grok-bot's
`SandRunScheduler`: messages sent while the bot is busy are queued, queued
work is graded into three lanes assigned automatically by source
(user > agent > background), and a priority judgment decides when an
incoming item preempts the in-flight run (with redrive for displaced work).

Normal (non-bot) duya sessions keep the existing mailbox path untouched.

## Background (grok-bot reference, E:\cloned-projects\grok-bot-0.18-reconstructed)

- `source/host/extensions/transcript/run-scheduler.ts` `SandRunScheduler`:
  per-agent queue with three FIFO lanes (`user` / `agent` / `background`),
  one active slot, strict drain order user > agent > background.
- New user messages preempt the active run (`send-turn-dispatch.ts:122-134`,
  "superseded by a new user message") and run immediately as a fresh turn.
- Watchdog hard-preempts a wedged run when a user task waits > 120 s
  (+30 s grace, env-tunable).
- Agent-to-agent sends may pass `priority: true` to preempt a non-user run.

## Current duya substrate (already present)

- Three-lane wake queue with strict lane order + dedupe/merge
  (`packages/agent/src/wake/queue.ts`, `types.ts`).
- Preemption decision `decidePreemption` + redrive
  (`packages/agent/src/wake/preemption.ts`, wired in
  `electron/wake/wake-dispatcher.ts tryPreemptRunning`).
- Unclaimed `user` lane: `promptForItem` handles `kind: 'user'` but no
  producer exists.
- Cross-process interrupt `DELETE /sessions/:id/chat` (ownership-agnostic).
- Shared-DB runtime lock `session_runtime_locks` visible to main process;
  `lock:release → notifySessionIdle` re-kick.

## Gaps being closed

1. Lock rows carry no run origin — a renderer-driven run cannot be
   attributed user vs agent vs background, so preemption never touches it.
2. `user.message` lane has no producer: the bot DM composer blocks sends
   while busy and falls back to a renderer-local FIFO with no priority.
3. No user-semantics-preserving dispatch path for the user lane
   (`runWakePromptInExistingSession` is cron-flavored: `effort: 'off'`,
   hidden, default model).
4. Agent server returns a hard 409 when busy; no server-side queueing.
5. Group member turns (plan 478) 409-pass when the member is busy.

## Architecture decision

The main-process wake dispatcher becomes the authoritative run queue for
bot sessions; the renderer is demoted to a streaming client. Queueing,
lane grading, and preemption decisions live in main. Turn execution
prefers the renderer (`startStream`, keeping SSE streaming UX); main runs
a hidden user turn itself only when no renderer view can take it.

---

## P1 — Run attribution (foundation)

- [x] P1.1 `session_runtime_locks.origin TEXT` column
      (`electron/db/schema.ts` migration + `LockStore` in
      `electron/db/core/stores.ts`: `acquire(..., origin)`,
      new `lockOrigin(sessionId)`).
- [x] P1.2 `electron/agents/server/chat-runtime-lock.ts` passes origin
      through; `router.ts` sets it: renderer chat → `'user'`, wake-run
      dispatch → per item lane, group member hidden runs → `'agent'`.
- [x] P1.3 db-bridge `lock:origin` action.

## P2 — User lane producer: bot DM send through the main gate

- [x] P2.1 IPC `bot:sendTurn` `{ agentId, text, clientMsgId }` → enqueue
      `WakeItem { source: 'user.message', lane: 'user',
      payload: { kind: 'user', text, messageId } }`; returns
      `{ action: 'start' }` (idle → renderer runs its normal stream) or
      `{ action: 'queued' }`.
- [x] P2.2 User-lane dispatch: drain pushes `bot:scheduled-turn`
      `{ sessionId, text, messageId, turnEpoch }` to renderer windows;
      `BotDirectChatView` picks it up with `startStream`. Fallback
      `runUserTurnInSession` (wake-run variant: bot model/effort/profile,
      `userTurn: true`, not a wake run) when no renderer view takes it.
- [x] P2.3 Epoch: user-lane enqueue advances turn epoch (parity with
      `advanceUserTurn`).
- [x] P2.4 Renderer: `App.tsx handleBotDirectSend` always goes through the
      IPC gate (busy branch no longer enqueues into the renderer FIFO);
      renderer FIFO stays workspace-only. Sidebar bot contact gets a real
      `status: 'queued'` from queue depth.
- [x] P2.5 Race backstop: renderer `startStream` hitting 409 retries
      through the gate (queued).

## P3 — Preemption rules (grok supersede semantics)

- [x] P3.1 `decidePreemption`: incoming user-lane item always preempts —
      including `currentOrigin === 'user'` (grok "superseded by a new user
      message"). Priority DM still only preempts non-user runs. Decision
      carries `redrive`: displaced user runs are NOT redriven (user
      superseded them on purpose; transcript is persisted), agent/
      background runs are redriven as today.
- [x] P3.2 `tryPreemptRunning` generalization: classify the in-flight run
      via the lock origin (P1) instead of "dispatcher-owned only";
      interrupt via `interruptCronSession` per the decision; redrive logic
      for dispatcher-owned items unchanged.

## P4 — Group room turns through the scheduler (on top of plan 478)

- [x] P4.1 New wake source `'group.turn'` (agent lane) +
      `dispatchBotTurn(agentId, item)` scheduler API; member turn execution
      in `electron/wake/group-turn-dispatcher.ts` goes through it — busy
      member queues instead of 409-pass; preempted member runs redrive;
      room-level epoch and serialization semantics preserved.
- [x] P4.2 In-room user post keeps interrupting the in-flight member run;
      the displaced run re-enters its lane via redrive.
- [x] P4.3 409 demoted to a race backstop (park-and-retry-on-idle).

## P5 — Watchdog + persistence (grok parity extras)

- [x] P5.1 Watchdog: user-lane item waiting > threshold (default 120 s,
      env `DUYA_BOT_WATCHDOG_MS`) interrupts the wedged active run. The
      grok-style 30 s grace / zombie escape is unnecessary here — duya's
      DELETE interrupt hard-kills the worker after 2 s and the lock TTL
      (300 s) stays the ultimate backstop.
- [x] P5.2 Persistence: queued `user.message` / `agent.dm` items are
      persisted to `pending_wakes` at enqueue and cleared at dispatch;
      `wake-rearm.ts` rearms both after restart. `group.turn` is
      deliberately not persisted (the room orchestrator chain is in-memory
      and dies with the process). `PendingWakeStore` was also wired into
      `CoreStores` (it existed unwired — Plan 476 Phase 3 gap), which makes
      the existing background-kind rearm path functional.

## Verification

- Vitest: `decidePreemption` new semantics, LockStore origin, scheduler
  decision unit tests, bot-contacts queued status.
- Gates: `npm run typecheck:all` plus manual
  `npx tsc -p electron/tsconfig.json` (typecheck:all excludes electron/).

## Non-goals

- Normal (non-bot) session chat: mailbox path unchanged.
- Per-message manual priority picker in the bot composer (lanes are
  source-assigned, grok parity).
- Rate limiting / channel quota management (488 non-goal).

## Status notes (2026-09-06)

- P1–P5 implemented; preemption / watchdog / rearm unit tests green.
- `stores.test.ts` LockStore cases run only under the node ABI (skipped
  while Electron holds the better-sqlite3 binary) — they run in CI.
- Renderer wiring in `src/App.tsx` and the `provider` field in
  `bot-contacts.ts` are interleaved with the parallel bot-model rework in
  the shared checkout — commit those together with that cluster.
- P4.3 note: with member turns dispatched through the scheduler, the busy
  case parks on the agent lane; the server 409 only remains as a race
  backstop (a 409 degrades to a member pass, pre-existing semantics).
- Plan 476 Phase 3 completion note: `PendingWakeStore` existed but was
  never wired into `CoreStores` — P5.2 wired it (migration + store init),
  which also makes `wake-rearm` functional for the first time.
