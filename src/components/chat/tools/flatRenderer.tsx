// Render-orchestration helpers for the ToolActionsGroup top-level
// chrome. Extracted from ToolActionsGroup.tsx so the parent component
// stays focused on the mount + state machine; these helpers are pure
// functions of their inputs and stay in one file for readability.

import React from 'react';
import { Group } from './group/Group';
import { ToolActionRow } from './rows/ToolActionRow';
import { ThinkingRow } from './rows/ThinkingRow';
import { TextRow } from './rows/TextRow';
import { HookActionRow } from './rows/HookActionRow';
import { CompactSummary } from '../CompactSummary';
import type { ActionItem, Segment, ToolAction } from './types';
import type { AgentProgressEventWithMeta } from '@/hooks/useStreamingAgentProgress';
import type { TranslationKey } from '@/i18n';

// Find the index of the last text action so the renderer can pass the
// `isLastTextAction` flag to it. The last text block is the one that's
// still growing as SSE text deltas arrive — it's the only block that
// actually needs the typewriter pacing.
function findLastTextIndex(actions: ActionItem[]): number {
  for (let i = actions.length - 1; i >= 0; i--) {
    if (actions[i].kind === 'text') return i;
  }
  return -1;
}

// Index of the last work action (tool / thinking / hook). In focus mode a
// text action only stays visible when it trails ALL work — anything at or
// before this index is intermediate narration and gets hidden.
function findLastWorkIndex(actions: ActionItem[]): number {
  for (let i = actions.length - 1; i >= 0; i--) {
    const kind = actions[i].kind;
    if (kind === 'tool' || kind === 'thinking' || kind === 'hook') return i;
  }
  return -1;
}

function renderActionItem(
  action: ActionItem,
  index: number,
  isStreaming?: boolean,
  isLastTextAction?: boolean,
): React.ReactNode {
  const key = `${action.kind}-${index}`;
  // Global gate: no block is "live" once the round's stream has ended,
  // even if the action itself still carries a live flag (the transient
  // view persists into terminal phases). Without this gate the rows'
  // typewriter rAF loops and shimmers kept running after completion.
  const streamActive = !!isStreaming;
  switch (action.kind) {
    case 'thinking':
      return (
        <ThinkingRow
          key={key}
          content={action.content}
          isStreaming={streamActive && !!action.isStreaming}
        />
      );
    case 'text':
      // Only the last (still-growing) text block needs the typewriter
      // pacing. Older blocks have stable content; the typewriter's rAF
      // loop would be a no-op for them but we'd rather not even mount
      // the extra state.
      return <TextRow key={key} content={action.content} isStreaming={streamActive && !!isLastTextAction} />;
    case 'tool':
      return <ToolActionRow key={key} tool={action.tool} streamingToolOutput={action.streamingToolOutput} />;
    case 'hook':
      // Plan 437: hook events render through the dedicated row that
      // shares ActionRowChrome with every other action.
      return <HookActionRow key={key} hook={action.hook} />;
    case 'widget':
      return (
        <WidgetActionItem
          key={key}
          content={action.content}
          sourceMessageId={action.sourceMessageId}
          sourceLabel={action.sourceLabel}
        />
      );
    case 'compact':
      // Context compaction renders inline like a tool row. The 'compacting'
      // phase shows a spinner; 'done' collapses to the compacted summary and
      // 'error' shows the failure reason — all sharing ActionRowChrome.
      return (
        <CompactSummary
          key={key}
          compactedMessageCount={action.compactedMessageCount}
          status={action.phase === 'compacting' ? 'running' : action.phase === 'error' ? 'error' : 'success'}
          verbKey={
            action.phase === 'compacting'
              ? 'streaming.toolAction.compact.inProgress'
              : action.phase === 'error'
                ? 'streaming.toolAction.compact.failed'
                : 'streaming.toolAction.compact.collapsed'
          }
        />
      );
    default:
      return null;
  }
}

// Lazy import — avoids pulling WidgetRenderer / WidgetErrorBoundary
// into the hot path used by every other tool row. Rendered inline so
// the import stays inside the JSX path and the chunk is split.
const WidgetRenderer = React.lazy(() => import('../WidgetRenderer').then((m) => ({ default: m.WidgetRenderer })));
const WidgetErrorBoundary = React.lazy(() => import('../WidgetErrorBoundary').then((m) => ({ default: m.WidgetErrorBoundary })));

function WidgetActionItem({
  content,
  sourceMessageId,
  sourceLabel,
}: {
  content: string;
  sourceMessageId?: string;
  sourceLabel?: string;
}) {
  return (
    <React.Suspense fallback={null}>
      <WidgetErrorBoundary widgetCode={content}>
        <WidgetRenderer
          widgetCode={content}
          isStreaming={false}
          sourceMessageId={sourceMessageId}
          sourceLabel={sourceLabel}
        />
      </WidgetErrorBoundary>
    </React.Suspense>
  );
}

// Build a map from action index → group segment that starts at that
// index. Only GROUP segments are included — single segments (lone
// tool / thinking) render through the standalone path.
//
// This map is what fixes the "group starts with thinking" bug: the
// old loop only entered the segment-matching path when
// `action.kind === 'tool'`, so a group whose first entry was a
// thinking row rendered that thinking as a standalone item FIRST,
// then rendered the whole group (including the thinking again) —
// producing a duplicate thinking row that looked like the group was
// split. By pre-computing the start index of every group, the loop
// can recognize a group starting with thinking and render it once.
type GroupSegment = Extract<Segment, { kind: 'group' }>;

function buildGroupStartMap(
  actions: ActionItem[],
  segments: Segment[],
): Map<number, { seg: GroupSegment; size: number }> {
  const map = new Map<number, { seg: GroupSegment; size: number }>();
  let actionIdx = 0;
  for (const seg of segments) {
    // Skip text / widget / compact actions — they're never inside a segment.
    while (
      actionIdx < actions.length &&
      (actions[actionIdx].kind === 'text' || actions[actionIdx].kind === 'widget' || actions[actionIdx].kind === 'compact')
    ) {
      actionIdx++;
    }
    if (seg.kind === 'group') {
      const size = seg.entries.length;
      if (actionIdx < actions.length) {
        map.set(actionIdx, { seg, size });
      }
      actionIdx += size;
    } else {
      // single segment — not added to map, just advance.
      actionIdx += 1;
    }
  }
  return map;
}

// Renders the `flat` body — preserves action order but collapses
// consecutive browser / context tools into groups.
export function renderFlatActions(
  actions: ActionItem[],
  segments: Segment[],
  _segmentKeys: Array<{ segment: Segment; keys: string[] }>,
  isStreaming: boolean | undefined,
  streamingToolOutput: string | undefined,
  agentProgressEvents: AgentProgressEventWithMeta[] | undefined,
  focus?: boolean,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const lastTextIdx = findLastTextIndex(actions);
  const lastWorkIdx = focus ? findLastWorkIndex(actions) : -1;
  const groupStartMap = buildGroupStartMap(actions, segments);

  let toolIdx = 0;
  for (let i = 0; i < actions.length; i++) {
    const groupStart = groupStartMap.get(i);
    if (groupStart) {
      const { seg, size } = groupStart;
      out.push(
        <Group
          key={`group-${toolIdx}`}
          entries={seg.entries}
          flat
          streamLive={!!isStreaming}
          streamingToolOutput={streamingToolOutput}
          agentProgressEvents={agentProgressEvents}
        />,
      );
      toolIdx += seg.entries.filter((e) => e.kind === 'tool').length;
      // Advance past all entries in this group (tools + thinking).
      // The for-loop's i++ handles the +1, so we add size - 1.
      i += size - 1;
    } else {
      const action = actions[i];
      // Focus mode: intermediate text (anything not trailing all work)
      // is hidden — only the final output stays visible.
      if (focus && action.kind === 'text' && i <= lastWorkIdx) continue;
      if (action.kind === 'tool') {
        const isRunning = !action.tool.result;
        out.push(
          <ToolActionRow
            key={`tool-${toolIdx}`}
            tool={action.tool}
            streamingToolOutput={isRunning ? streamingToolOutput : undefined}
            agentProgressEvents={agentProgressEvents}
          />,
        );
        toolIdx++;
      } else {
        out.push(renderActionItem(action, i, isStreaming, i === lastTextIdx));
      }
    }
  }
  return out;
}

// For the indented body, we want to preserve the original action order
// (thinking → tool → text → widget …). Walk `actions` and emit either
// a grouped render unit (≥2 entries) or the original action item.
export function renderOrderedBody(
  actions: ActionItem[],
  segments: Segment[],
  lastRunningTool: ToolAction | undefined,
  streamingToolOutput: string | undefined,
  agentProgressEvents: AgentProgressEventWithMeta[] | undefined,
  isStreaming: boolean | undefined,
  focus?: boolean,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const lastTextIdx = findLastTextIndex(actions);
  const lastWorkIdx = focus ? findLastWorkIndex(actions) : -1;
  const groupStartMap = buildGroupStartMap(actions, segments);

  let toolIdx = 0;
  for (let i = 0; i < actions.length; i++) {
    const groupStart = groupStartMap.get(i);
    if (groupStart) {
      const { seg, size } = groupStart;
      out.push(
        <Group
          key={`group-${toolIdx}`}
          entries={seg.entries}
          streamLive={!!isStreaming}
          streamingToolOutput={streamingToolOutput}
          agentProgressEvents={agentProgressEvents}
        />,
      );
      toolIdx += seg.entries.filter((e) => e.kind === 'tool').length;
      // Advance past all entries in this group (tools + thinking).
      i += size - 1;
    } else {
      const action = actions[i];
      // Focus mode: intermediate text (anything not trailing all work)
      // is hidden — only the final output stays visible.
      if (focus && action.kind === 'text' && i <= lastWorkIdx) continue;
      if (action.kind === 'tool') {
        // Only the last running tool receives the live streaming
        // output — every other finished tool renders its persisted
        // result.
        const isLastRunning = lastRunningTool?.id === action.tool.id;
        out.push(
          <ToolActionRow
            key={`tool-${toolIdx}`}
            tool={action.tool}
            streamingToolOutput={isLastRunning ? streamingToolOutput : undefined}
            agentProgressEvents={agentProgressEvents}
          />,
        );
        toolIdx++;
      } else {
        out.push(renderActionItem(action, i, isStreaming, i === lastTextIdx));
      }
    }
  }
  return out;
}

export function computeSummaryFromActions(
  actions: ActionItem[],
  isStreaming: boolean,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string[] {
  const toolActions = actions.filter((a): a is ActionItem & { kind: 'tool' } => a.kind === 'tool');
  const runningCount = toolActions.filter((a) => a.tool.result === undefined).length;
  const doneCount = toolActions.length - runningCount;
  const summaryParts: string[] = [];
  if (runningCount > 0) summaryParts.push(t('streaming.actions.running', { count: runningCount }));
  if (doneCount > 0) summaryParts.push(t('streaming.actions.completed', { count: doneCount }));
  if (runningCount === 0 && isStreaming) summaryParts.push(t('streaming.actions.generating'));
  if (summaryParts.length === 0) summaryParts.push(`${actions.length} actions`);
  return summaryParts;
}

export function getLastRunningToolAction(actions: ActionItem[]): ToolAction | undefined {
  for (let i = actions.length - 1; i >= 0; i--) {
    const action = actions[i];
    if (action.kind === 'tool' && action.tool.result === undefined) {
      return action.tool;
    }
  }
  return undefined;
}

// Map each segment back to matching action indices (used as React keys).
export function computeSegmentActionKeys(segments: Segment[]): Array<{ segment: Segment; keys: string[] }> {
  const out: Array<{ segment: Segment; keys: string[] }> = [];
  let toolIdx = 0;
  for (const seg of segments) {
    // Group keys: one per entry (entry-N). Single keys: a single
    // tool-N (we still use tool-* for backward compat with downstream
    // consumers like ToolActionsGroup's StreamingActionsBody, which
    // assumes a 1:1 mapping between segments and tool indices).
    const isGroup = seg.kind === 'group';
    const count = isGroup ? seg.entries.length : 1;
    const keys: string[] = [];
    for (let k = 0; k < count; k++) {
      keys.push(isGroup ? `entry-${toolIdx + k}` : `tool-${toolIdx}`);
    }
    if (!isGroup) toolIdx++;
    out.push({ segment: seg, keys });
  }
  return out;
}
