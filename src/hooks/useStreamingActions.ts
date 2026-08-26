import { useEffect, useMemo, useRef, useState } from 'react';
import { subscribeToStreamingEvents, type StreamingEvent } from '@/lib/stream-session-manager';
import {
  extractDurableToolIds,
  subtractDurableStreamingEvents,
} from '@/lib/durable-stream-subtraction';
import type { ActionItem } from '@/components/chat/ToolActionsGroup';
import { buildToolAction } from '@/components/chat/tools/normalize';
import { useShowHookInvocations } from './useShowHookInvocations';
import { useConversationStore } from '@/stores/conversation-store';

function streamingEventsToActions(events: StreamingEvent[]): ActionItem[] {
  const actions: ActionItem[] = [];

  // Pre-pass: build an id -> tool_result map so the tool_use branch can
  // look up its matching result in O(1) instead of O(n) per use (which
  // was the dominant cost during multi-tool streaming turns — see
  // plan 236 Phase 1).
  const toolResultById = new Map<string, Extract<StreamingEvent, { type: 'tool_result' }>['toolResult']>();
  for (const event of events) {
    if (event.type === 'tool_result') {
      toolResultById.set(event.toolResult.tool_use_id, event.toolResult);
    }
  }

  for (const event of events) {
    switch (event.type) {
      case 'text':
        // stream-session-manager accumulates each text event's `content`
        // in-place on the trailing text event; adjacent text events only
        // appear in the array when a non-text event (tool_use / result /
        // viz / hook / thinking) was pushed in between. We previously
        // tried to "merge" adjacent text actions via mergeMarkdownFragments,
        // but both sides were already-cumulative strings (the previous
        // flush's `lastAction.content` + this flush's `event.content`),
        // so each rAF tick re-prepended the prior content via `\n\n`,
        // making the rendered TextRow grow as
        //   "A\n\nB" → "A\n\nB\n\nBC" → "A\n\nB\n\nBC\n\nBCD"
        // every flush — exactly the "打字机在不停重复流式输出" symptom.
        //
        // Push every text event as its own action. Cross-tool-result
        // markdown constructs (a table whose rows straddle a tool call)
        // will now render as two separate TextRow components, but agents
        // rarely emit such constructs across tool boundaries and the
        // streaming flow already shows the tool row between them.
        if (event.content) {
          actions.push({ kind: 'text', content: event.content });
        }
        break;
      case 'thinking': {
        if (event.content.trim()) {
          // Live only while this thinking block is still the trailing
          // event. It used to be pinned to `true` forever, which kept the
          // row's shimmer placeholder and typewriter rAF loop running long
          // after newer events (or the stream end) had closed the block.
          // This mapping re-runs on every rAF flush, so the flag flips off
          // as soon as any newer event lands behind it.
          const isTrailing = events[events.length - 1] === event;
          actions.push({ kind: 'thinking', content: event.content, isStreaming: isTrailing });
        }
        break;
      }
      case 'tool_use': {
        const toolUseId = event.toolUse.id;
        const resultInfo = toolResultById.get(toolUseId);
        // Route through the shared `buildToolAction` helper so the
        // streaming path and the persisted path (`messageToActionItems`)
        // produce byte-identical `ToolAction` shapes. Any future field
        // addition (e.g. a new metadata sub-key) only needs to land in
        // `tools/normalize.ts` once.
        actions.push({
          kind: 'tool',
          tool: buildToolAction(
            toolUseId,
            event.toolUse.name,
            event.toolUse.input,
            resultInfo,
            undefined,
            event.toolUse.stage,
          ),
        });
        break;
      }
      case 'tool_result':
        // Skip standalone tool_results that were already paired with tool_use
        break;
      case 'viz':
        if (event.content.trim()) {
          actions.push({ kind: 'widget', content: event.content });
        }
        break;
      case 'hook_invocation':
        // Plan 437: hook events arrive via `handleAgentProgressEvent` in
        // stream-session-manager and are appended to `streamingEvents` as
        // `hook_invocation` variants. Push them through unchanged — the
        // group / row pipeline renders them through `HookActionRow`.
        actions.push({ kind: 'hook', hook: event.hook });
        break;
    }
  }

  return actions;
}

/**
 * Plan 437: same as `streamingEventsToActions` but drops hook events
 * when the user has turned them off in Settings → Hooks. Default ON,
 * so the feature is visible by default; this only matters when the
 * toggle is explicitly off.
 */
function streamingEventsToActionsFiltered(
  events: StreamingEvent[],
  showHookInvocations: boolean,
): ActionItem[] {
  if (showHookInvocations) return streamingEventsToActions(events);
  const filtered: StreamingEvent[] = [];
  for (const e of events) {
    if (e.type === 'hook_invocation') continue;
    filtered.push(e);
  }
  return streamingEventsToActions(filtered);
}

export function useStreamingActions(sessionId: string): ActionItem[] {
  const [actions, setActions] = useState<ActionItem[]>([]);
  // Text and thinking deltas mutate the trailing StreamingEvent in place.
  // Keep the newest snapshot and derive actions at most once per animation
  // frame: reference equality cannot tell whether an in-place event changed.
  const latestEventsRef = useRef<StreamingEvent[] | null>(null);
  const frameRef = useRef<number | null>(null);
  // Plan 437: re-read the toggle on every render so a mid-round toggle
  // change in Settings → Hooks takes effect on the next animation frame flush.
  const showHookInvocations = useShowHookInvocations();

  // Plan 447: subtract the durable-covered prefix of the streaming timeline
  // (plan 441 persists rounds to the DB mid-turn, so switching back to an
  // active session replays them under StreamingMessage). Durable tool ids
  // come from the conversation store's DB-loaded rows; kept in a ref so the
  // rAF flush always sees the latest value without resubscribing.
  const durableMessages = useConversationStore((s) => s.messages[sessionId]);
  const durableIds = useMemo(
    () => extractDurableToolIds(durableMessages ?? []),
    [durableMessages],
  );
  const durableIdsRef = useRef(durableIds);
  const scheduleFlushRef = useRef<(() => void) | null>(null);

  // Re-flush when a DB reload lands after events were already flushed,
  // otherwise the subtraction would only apply on the next stream event.
  useEffect(() => {
    durableIdsRef.current = durableIds;
    scheduleFlushRef.current?.();
  }, [durableIds]);

  useEffect(() => {
    // Reset on sessionId change so a new session starts fresh.
    latestEventsRef.current = null;
    setActions([]);

    const flush = () => {
      frameRef.current = null;
      const events = latestEventsRef.current;
      if (events) {
        // Plan 437: drop hook events when the user has toggled them off
        // in Settings → Hooks. Read the latest value at flush time so a
        // mid-round toggle takes effect immediately.
        // Plan 447: drop events already covered by durable DB rows first.
        const pending = subtractDurableStreamingEvents(events, durableIdsRef.current);
        setActions(streamingEventsToActionsFiltered(pending, showHookInvocations));
      }
    };

    const scheduleFlush = () => {
      if (frameRef.current !== null) return;
      if (typeof requestAnimationFrame === 'undefined') {
        flush();
        return;
      }
      frameRef.current = requestAnimationFrame(flush);
    };
    scheduleFlushRef.current = scheduleFlush;

    const unsubscribe = subscribeToStreamingEvents(sessionId, (events) => {
      latestEventsRef.current = events;
      scheduleFlush();
    });

    return () => {
      unsubscribe();
      scheduleFlushRef.current = null;
      if (frameRef.current !== null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(frameRef.current);
      }
      frameRef.current = null;
    };
  }, [sessionId]);

  return actions;
}
