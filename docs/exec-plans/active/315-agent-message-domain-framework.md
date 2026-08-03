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

- Migrate `DuyaAgent.this.messages` to the framework in small call-site groups.
- Move mailbox, AGENTS.md, attachments, memory, mode, and task notifications to
  explicit runtime-context messages.
- Persist compaction entries instead of overwriting or re-appending history.
- Route all provider conversions through the model-boundary projector.
- Replace renderer history repair with a canonical transcript projection.

No deferred item should begin until Phase 1 tests remain green and the runtime
migration order is explicitly approved.
