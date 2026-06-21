// Render-orchestration helpers for the ToolActionsGroup top-level
// chrome. Extracted from ToolActionsGroup.tsx so the parent component
// stays focused on the mount + state machine; these helpers are pure
// functions of their inputs and stay in one file for readability.

import React from 'react';
import { Group } from './group/Group';
import { ToolActionRow } from './rows/ToolActionRow';
import { ThinkingRow } from './rows/ThinkingRow';
import { TextRow } from './rows/TextRow';
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

function renderActionItem(
  action: ActionItem,
  index: number,
  isStreaming?: boolean,
  isLastTextAction?: boolean,
): React.ReactNode {
  const key = `${action.kind}-${index}`;
  switch (action.kind) {
    case 'thinking':
      return <ThinkingRow key={key} content={action.content} isStreaming={action.isStreaming ?? isStreaming} />;
    case 'text':
      // Only the last (still-growing) text block needs the typewriter
      // pacing. Older blocks have stable content; the typewriter's rAF
      // loop would be a no-op for them but we'd rather not even mount
      // the extra state.
      return <TextRow key={key} content={action.content} isStreaming={isLastTextAction} />;
    case 'tool':
      return <ToolActionRow key={key} tool={action.tool} streamingToolOutput={action.streamingToolOutput} />;
    case 'widget':
      return (
        <WidgetActionItem
          key={key}
          content={action.content}
          sourceMessageId={action.sourceMessageId}
          sourceLabel={action.sourceLabel}
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

// Renders the `flat` body — preserves action order but collapses
// consecutive browser / context tools into groups.
export function renderFlatActions(
  actions: ActionItem[],
  segments: Segment[],
  _segmentKeys: Array<{ segment: Segment; keys: string[] }>,
  isStreaming: boolean | undefined,
  streamingToolOutput: string | undefined,
  agentProgressEvents: AgentProgressEventWithMeta[] | undefined,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let toolIdx = 0;
  let segIdx = 0;
  const lastTextIdx = findLastTextIndex(actions);
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    if (action.kind === 'tool') {
      if (segIdx >= segments.length) {
        out.push(renderActionItem(action, i, isStreaming, i === lastTextIdx));
      } else {
        const seg = segments[segIdx];
        if (seg.kind === 'single' && seg.tool === action.tool) {
          const isLastRunning = !seg.tool.result;
          out.push(
            <ToolActionRow
              key={`tool-${toolIdx}`}
              tool={seg.tool}
              streamingToolOutput={isLastRunning ? streamingToolOutput : undefined}
              agentProgressEvents={agentProgressEvents}
            />,
          );
          toolIdx++;
          segIdx++;
        } else {
          if (seg.kind === 'group') {
            out.push(
              <Group
                key={`group-${toolIdx}`}
                tools={seg.tools}
                flat
                streamingToolOutput={streamingToolOutput}
                agentProgressEvents={agentProgressEvents}
              />,
            );
            toolIdx += seg.tools.length;
          } else {
            // single fallback (shouldn't reach here)
            out.push(renderActionItem(action, i, isStreaming, i === lastTextIdx));
            toolIdx++;
          }
          segIdx++;
          // After rendering a group, the remaining tools in the group are
          // already shown inside it. Skip past the next (groupSize - 1)
          // tool actions in `actions` so they aren't re-rendered as
          // standalone rows. Non-tool actions encountered in between are
          // still rendered in their original position.
          const groupSize = seg.kind === 'group' ? seg.tools.length : 1;
          let toolsToSkip = groupSize - 1;
          while (toolsToSkip > 0 && i + 1 < actions.length) {
            i++;
            if (actions[i].kind === 'tool') {
              toolsToSkip--;
            } else {
              out.push(renderActionItem(actions[i], i, isStreaming, i === lastTextIdx));
            }
          }
        }
      }
    } else {
      out.push(renderActionItem(action, i, isStreaming, i === lastTextIdx));
    }
  }
  return out;
}

// For the indented body, we want to preserve the original action order
// (thinking → tool → text → widget …). Walk `actions` and emit either
// a grouped render unit (≥2 tool calls) or the original action item.
export function renderOrderedBody(
  actions: ActionItem[],
  segments: Segment[],
  lastRunningTool: ToolAction | undefined,
  streamingToolOutput: string | undefined,
  agentProgressEvents: AgentProgressEventWithMeta[] | undefined,
  isStreaming: boolean | undefined,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let toolIdx = 0;
  let segIdx = 0;
  const lastTextIdx = findLastTextIndex(actions);
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    if (action.kind === 'tool') {
      if (segIdx >= segments.length) {
        out.push(renderActionItem(action, i, isStreaming, i === lastTextIdx));
      } else {
        const seg = segments[segIdx];
        if (seg.kind === 'single' && seg.tool === action.tool) {
          out.push(renderSegment(seg, [`tool-${toolIdx}`], lastRunningTool, streamingToolOutput, agentProgressEvents));
          toolIdx++;
          segIdx++;
        } else if (seg.kind === 'group') {
          // group segment
          out.push(
            renderSegment(
              seg,
              seg.tools.map((_t, k) => `tool-${toolIdx + k}`),
              lastRunningTool,
              streamingToolOutput,
              agentProgressEvents,
            ),
          );
          toolIdx += seg.tools.length;
          segIdx++;
          // After rendering a group, the remaining tools in the group are
          // already shown inside it. Skip past the next (groupSize - 1)
          // tool actions in `actions` so they aren't re-rendered as
          // standalone rows. Non-tool actions encountered in between are
          // still rendered in their original position.
          let toolsToSkip = seg.tools.length - 1;
          while (toolsToSkip > 0 && i + 1 < actions.length) {
            i++;
            if (actions[i].kind === 'tool') {
              toolsToSkip--;
            } else {
              out.push(renderActionItem(actions[i], i, isStreaming, i === lastTextIdx));
            }
          }
        } else {
          // defensive — render as a single
          out.push(renderSegment(seg, [`tool-${toolIdx}`], lastRunningTool, streamingToolOutput, agentProgressEvents));
          toolIdx++;
          segIdx++;
        }
      }
    } else {
      out.push(renderActionItem(action, i, isStreaming, i === lastTextIdx));
    }
  }
  return out;
}

function renderSegment(
  seg: Segment,
  keys: string[],
  lastRunningTool: ToolAction | undefined,
  streamingToolOutput: string | undefined,
  agentProgressEvents: AgentProgressEventWithMeta[] | undefined,
): React.ReactNode {
  if (seg.kind === 'single') {
    const isLastRunning = lastRunningTool?.id === seg.tool.id;
    return (
      <ToolActionRow
        key={keys[0]}
        tool={seg.tool}
        streamingToolOutput={isLastRunning ? streamingToolOutput : undefined}
        agentProgressEvents={agentProgressEvents}
      />
    );
  }
  return (
    <Group
      key={keys.join('-')}
      tools={seg.tools}
      streamingToolOutput={streamingToolOutput}
      agentProgressEvents={agentProgressEvents}
    />
  );
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
    const count = seg.kind === 'single' ? 1 : seg.tools.length;
    const keys: string[] = [];
    for (let k = 0; k < count; k++) {
      keys.push(`tool-${toolIdx}`);
      toolIdx++;
    }
    out.push({ segment: seg, keys });
  }
  return out;
}
