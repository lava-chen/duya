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

/**
 * The WHOLE run-derived block sequence, replayable into a cleared model.
 *
 * This is T11 step 2's core. Where `projectRunSessionView` states only what
 * changed, this derives everything a run contributed, in the order the run
 * sequence put it — which is what lets the render source be switched without
 * the transcript reordering itself.
 *
 * ## Why the timeline, not the entity lists
 *
 * `snapshot.messages` and `snapshot.toolCalls` are per-entity collections with
 * no order between them. Emitting "all messages, then all tools" is how a tool
 * line ends up above text written after it, which is the exact defect the TUI
 * already had once. So the walk is over `snapshot.timeline`, which is already
 * sequence-sorted, and each entity is emitted at the position of its FIRST
 * event.
 *
 * ## Why final state is emitted, not the delta
 *
 * This is a replay, not a live stream: a `text` block carries the message's
 * finished text rather than a fragment. Replaying fragments through an
 * appending reducer is how a reconnect produces doubled text.
 *
 * ## What it deliberately does NOT cover
 *
 * User blocks. They come from local input, never from the run event stream, so
 * they are not in the snapshot and no projection of shared state can rebuild
 * them. A render-source switch must therefore splice this sequence in place,
 * not replace the transcript wholesale.
 */
export function projectRunSessionFrames(snapshot: RunSessionSnapshot): LegacyFrame[] {
  const messages = new Map(snapshot.messages.map((message) => [message.messageId, message]));
  const tools = new Map(snapshot.toolCalls.map((tool) => [tool.toolCallId, tool]));
  const permissions = new Map(snapshot.permissions.map((entry) => [entry.requestId, entry]));

  const frames: LegacyFrame[] = [];
  const announcedMessages = new Set<string>();
  const announcedTools = new Set<string>();
  const settledTools = new Set<string>();
  const askedPermissions = new Set<string>();
  const resolvedPermissions = new Set<string>();
  let terminalStated = false;

  const messageIdOf = (payload: { readonly messageId?: string }): string | null =>
    typeof payload.messageId === 'string' && payload.messageId !== '' ? payload.messageId : null;

  for (const item of snapshot.timeline) {
    const payload = item.payload as {
      readonly type: string;
      readonly messageId?: string;
      readonly toolCallId?: string;
      readonly requestId?: string;
      readonly status?: string;
      readonly stopReason?: string | null;
      readonly error?: { readonly message: string };
      readonly kind?: string;
    };

    switch (payload.type) {
      case 'assistant.text_block':
      case 'assistant.text_delta': {
        const id = messageIdOf(payload);
        if (id === null || announcedMessages.has(id)) break;
        announcedMessages.add(id);
        const message = messages.get(id);
        if (message !== undefined && message.thinking !== '') {
          frames.push({ type: 'thinking', data: { content: message.thinking, messageId: id, index: 0 } });
        }
        if (message !== undefined && message.text !== '') {
          frames.push({ type: 'text', data: { content: message.text, messageId: id, index: 0 } });
        }
        break;
      }

      case 'assistant.thinking_block':
      case 'assistant.thinking_delta': {
        // A message whose only content is thinking announces itself here.
        const id = messageIdOf(payload);
        if (id === null || announcedMessages.has(id)) break;
        announcedMessages.add(id);
        const message = messages.get(id);
        if (message === undefined) break;
        if (message.thinking !== '') {
          frames.push({ type: 'thinking', data: { content: message.thinking, messageId: id, index: 0 } });
        }
        if (message.text !== '') {
          frames.push({ type: 'text', data: { content: message.text, messageId: id, index: 0 } });
        }
        break;
      }

      case 'tool.call_preview':
      case 'tool.call_started': {
        const callId = payload.toolCallId;
        if (callId === undefined || announcedTools.has(callId)) break;
        announcedTools.add(callId);
        const tool = tools.get(callId);
        if (tool === undefined) break;
        frames.push({
          type: 'tool_use',
          data: { id: callId, name: tool.name, input: tool.arguments ?? tool.provisionalArguments ?? {} },
        });
        break;
      }

      case 'tool.timed_out': {
        const callId = payload.toolCallId;
        if (callId === undefined || settledTools.has(callId)) break;
        const tool = tools.get(callId);
        // Still timed out at the end of the run? Only then is the timeout the
        // call's last word. A call that recovered keeps its completion.
        if (tool === undefined || tool.phase !== 'timed_out') break;
        settledTools.add(callId);
        frames.push({ type: 'tool_timed_out', data: { id: callId, name: tool.name, durationMs: tool.durationMs } });
        break;
      }

      case 'tool.call_completed': {
        const callId = payload.toolCallId;
        if (callId === undefined || settledTools.has(callId)) break;
        const tool = tools.get(callId);
        if (tool === undefined) break;
        settledTools.add(callId);
        const outcome = tool.outcome?.outcome;
        frames.push({
          type: 'tool_result',
          data: {
            id: callId,
            result: tool.result ?? '',
            error: outcome !== undefined && outcome !== 'success' && outcome !== 'indeterminate',
            indeterminate: outcome === 'indeterminate',
          },
        });
        break;
      }

      case 'permission.requested': {
        const requestId = payload.requestId;
        if (requestId === undefined || askedPermissions.has(requestId)) break;
        askedPermissions.add(requestId);
        const entry = permissions.get(requestId);
        if (entry === undefined) break;
        frames.push({
          type: 'permission',
          data: {
            requestId,
            toolName: entry.toolName,
            toolInput: entry.toolInput,
            reason: entry.reason ?? undefined,
            mode: entry.mode,
            blockedPath: entry.blockedPath ?? undefined,
            expiresAt: entry.expiresAt,
          },
        });
        break;
      }

      case 'permission.resolved': {
        const requestId = payload.requestId;
        if (requestId === undefined || resolvedPermissions.has(requestId)) break;
        resolvedPermissions.add(requestId);
        const entry = permissions.get(requestId);
        if (entry?.resolution == null) break;
        frames.push({
          type: 'permission_resolved',
          data: {
            requestId,
            action: entry.resolution.action,
            source: entry.resolution.source,
            latencyMs: entry.resolution.latencyMs,
            toolName: entry.toolName,
            reason: entry.resolution.reason,
          },
        });
        break;
      }

      case 'run.completed': {
        if (terminalStated) break;
        terminalStated = true;
        frames.push({ type: 'done', data: { reason: snapshot.run.stopReason ?? payload.status ?? 'completed' } });
        break;
      }

      case 'run.failed': {
        if (terminalStated) break;
        terminalStated = true;
        frames.push({
          type: 'error',
          data: { message: payload.error?.message ?? 'run failed', code: snapshot.run.error?.code ?? 'internal' },
        });
        break;
      }

      default:
        // Not every protocol event is transcript content. Silence here is the
        // same silence `TranscriptModel` already has for turn markers and
        // progress ticks, not a dropped fact: the delta projection above is
        // where those live.
        break;
    }
  }

  return frames;
}
