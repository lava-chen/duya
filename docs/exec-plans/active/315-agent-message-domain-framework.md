# Agent Message Domain Framework

## Objective

Introduce a Pi-inspired message domain without changing the active DuyaAgent
runtime. Separate durable timeline entries, runtime Agent messages, provider
messages, compaction checkpoints, and UI visibility so each later migration can
be verified independently.

## Phase 1: Standalone framework

- [x] Define an extensible `AgentMessage` union and first-party message kinds.
- [x] Define append-only message and compaction timeline entries.
- [x] Project the latest compaction checkpoint without deleting raw history.
- [x] Convert Agent messages to provider `Message[]` only at the model boundary.
- [x] Keep runtime persistence and UI visibility as separate policies.
- [x] Add focused tests for append invariants, custom messages, compaction, and
      safe turn boundaries.
- [x] Run focused tests and `npm run typecheck:all`.

## Deferred integration

- [x] Migrate `DuyaAgent.this.messages` to the framework in small call-site groups.
      Unified write path: `this.messages` is now a timeline-derived getter
      (`projectTimelinePersistenceMessages(this.timeline.snapshot())`), so the
      timeline is the single source of truth for the durable persistence
      projection. `_commitMessages()` only refreshes `sessionInfo` counters.
      All manual `this.messages = ...` syncs removed. The error path now
      reconciles the timeline via `setMessages(persistableMessages(...))` so
      an incomplete assistant is excluded from the durable projection.
      Behavior change: micro-cleanup's tool_result truncation is no longer
      persisted — the DB keeps full tool content (confirmed with user).
- Move mailbox, AGENTS.md, attachments, memory, mode, and task notifications to
  explicit runtime-context messages.
- Persist compaction entries instead of overwriting or re-appending history.
- Route all provider conversions through the model-boundary projector.
- Replace renderer history repair with a canonical transcript projection.

No deferred item should begin until Phase 1 tests remain green and the runtime
migration order is explicitly approved.
