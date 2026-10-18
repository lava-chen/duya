/**
 * run-session-view.ts — the TUI's view adapter over shared run state (plan 610 T11).
 *
 * ## Why this file exists
 *
 * The CLI TUI used to learn about a run one event at a time: `HostEventStream`
 * projected each native envelope into a legacy `LegacyFrame`, and the frame
 * WAS the state transition. That works only for events the projector has a case
 * for. Two protocol events have none, so two facts never reached the user:
 *
 *   - `tool.timed_out`      — the volatile notice that a call blew its deadline
 *   - `permission.resolved` — the durable answer to a question that was asked
 *
 * `SurfaceModel` keeps both. This module reads them off the shared snapshot and
 * states them as frames, so the view is driven by state rather than by an event
 * vocabulary that has to be extended one case at a time.
 *
 * ## Why it is a DELTA, not a full projection
 *
 * `TranscriptModel.apply` is incremental — it mutates the block list — and the
 * renderer redraws per frame. Emitting the whole surface on every snapshot would
 * either duplicate every block or force a rebuild the TUI is not shaped for. So
 * this emits only what CHANGED since the previous projection, keyed by the
 * entities carrying the two facts above. A projection is pure; the caller owns
 * the state it returns.
 *
 * ## Scope, stated honestly
 *
 * This is T11 step 1 (coexistence). The legacy projector still renders
 * everything it always did; this supplies only what it cannot express. NOT done
 * here, and named so it is not read as done:
 *
 *   - the render-source switch in `chat.ts` (step 2)
 *   - deleting the old reducer branches (step 3)
 *   - the permission OVERLAY: a resolution still reaches the transcript as a
 *     status line rather than closing the picker in place. The picker needs the
 *     `requestId` bookkeeping that only the overlay has, which is step 2's job.
 */
import type { PermissionAction, RunSessionSnapshot } from '@duya/client-core';
import type { LegacyFrame } from './blocks.js';

/** What the view has already stated, so it never states a fact twice. */
export interface RunSessionViewState {
  /** Tool calls whose timeout has been rendered. */
  readonly timedOutTools: ReadonlySet<string>;
  /** `requestId` -> the action already rendered for it. */
  readonly resolvedPermissions: ReadonlyMap<string, PermissionAction>;
}

export interface RunSessionViewProjection {
  readonly frames: readonly LegacyFrame[];
  readonly state: RunSessionViewState;
}

export function createRunSessionView(): RunSessionViewState {
  return { timedOutTools: new Set<string>(), resolvedPermissions: new Map<string, PermissionAction>() };
}

/**
 * Frames for the facts the legacy projector has no case for.
 *
 * Pure: the same `(previous, snapshot)` gives the same frames, and the returned
 * state is a NEW value — a caller that reuses the old one is not silently
 * mutating history.
 */
export function projectRunSessionView(
  previous: RunSessionViewState,
  snapshot: RunSessionSnapshot,
): RunSessionViewProjection {
  const timedOutTools = new Set(previous.timedOutTools);
  const resolvedPermissions = new Map(previous.resolvedPermissions);
  const frames: LegacyFrame[] = [];

  for (const tool of snapshot.toolCalls) {
    if (tool.phase !== 'timed_out') continue;
    if (timedOutTools.has(tool.toolCallId)) continue;
    timedOutTools.add(tool.toolCallId);
    frames.push({
      type: 'tool_timed_out',
      data: { id: tool.toolCallId, name: tool.name, durationMs: tool.durationMs },
    });
  }

  for (const permission of snapshot.permissions) {
    const resolution = permission.resolution;
    if (resolution === null) continue;
    if (resolvedPermissions.has(permission.requestId)) continue;
    resolvedPermissions.set(permission.requestId, resolution.action);
    // NOT a `status` frame: `TranscriptModel` treats those as chrome and drops
    // them from the transcript, so a resolution stated that way would live and
    // die with the activity row — which is the D9 complaint restated.
    frames.push({
      type: 'permission_resolved',
      data: {
        requestId: resolution.requestId,
        action: resolution.action,
        source: resolution.source,
        latencyMs: resolution.latencyMs,
        toolName: permission.toolName,
        reason: resolution.reason,
      },
    });
  }

  return { frames, state: { timedOutTools, resolvedPermissions } };
}
