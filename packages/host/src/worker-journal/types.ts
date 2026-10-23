/**
 * The worker-side mirror of the rollout event taxonomy.
 *
 * This used to be an independent union with two members, and it drifted:
 * `hook_invoked` lived here and nowhere else, so the storage layer could
 * not derive a `kind` for it and the write transaction died on a
 * TypeError while the rollout file kept an orphan line (plan 620
 * Phase A5).
 *
 * The mirror still has its own shape for `rebase` — the worker hands
 * over `Message[]` and the storage layer converts it to `MessageEntry[]`
 * — but the set of discriminators is now locked to the authority by a
 * compile-time assertion, and covered by a runtime test.
 */

import type { Message } from '@duya/agent-core/message';
import type {
  HookInvokedEvent,
  PromptSnapshotEvent,
  WorkerEmittableEventType,
} from '@duya/agent-protocol/rollout-events';

export type RolloutEvent =
  | {
      type: 'rebase';
      id: string;
      turnId: string;
      supersededUpToSeq: number | null;
      /**
       * Why this rebase was emitted. Drives rotation in the storage layer:
       * - `compaction` — auto/manual compaction; rotates the rollout file so the
       *   compacted summary lands as the first data row of a new generation
       *   (Plan 506 C1 + Plan 493 Phase B).
       * - `edit_resend` — user edit / message truncate; inline mutation that
       *   must NOT rotate (it is not an epoch boundary).
       *
       * Optional for backwards compatibility — historical events from before
       * this field existed are all compaction form (Plan 441), so the rotation
       * trigger treats a missing reason as `compaction`.
       */
      reason?: 'compaction' | 'edit_resend';
      newMessages: Message[];
      createdAt: number;
    }
  | HookInvokedEvent
  | PromptSnapshotEvent;

/** The discriminators this mirror can carry. */
export type WorkerRolloutEventType = RolloutEvent['type'];

/**
 * Compile-time lock: the mirror must cover every event type the
 * authority says a worker can emit.
 *
 * If a type is added to the authority and forgotten here, this
 * assignment stops type-checking — the failure lands in the build
 * instead of in a rollout file. (The storage layer owns the rest — the
 * rotation marker — and the journal never emits those.)
 */
export const MIRROR_COVERS_THE_AUTHORITY: WorkerEmittableEventType extends WorkerRolloutEventType
  ? true
  : never = true;

/**
 * The mirror must not carry a type the authority does not know: that is
 * the shape that used to make `deriveKind` throw and leave an orphan
 * line behind.
 */
export const MIRROR_TYPES_ARE_KNOWN: WorkerRolloutEventType extends WorkerEmittableEventType
  ? true
  : never = true;
