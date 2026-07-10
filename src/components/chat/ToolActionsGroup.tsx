// ToolActionsGroup — top-level chat-tool chrome.
//
// Two render paths share the same `actions` input:
//
//   1. `isStreaming === true`  → `StreamingActionsBody`
//      Flat, no chrome, no border, no summary row. thinking / tool /
//      text stream out like ordinary chat prose. Group headers still
//      wrap ≥2 consecutive tool calls but render collapsed by default,
//      so the visual noise during a working round is just the text
//      itself.
//
//   2. `isStreaming === false` → collapsible summary + bordered body
//      After the round finishes, the work artifacts get boxed behind a
//      one-line summary ("5 tools · Worked for 12s") that defaults to
//      collapsed. Click to expand. The collapsed default means a new
//      round always starts from a clean, quiet state — no expansion
//      state leaks between rounds.
//
// Public API (preserved for backward compatibility):
//   - `ToolActionsGroup` — main React component
//   - `pairTools` — pairs ToolUseInfo[] with ToolResultInfo[] for IPC
//   - `ToolAction` / `ActionItem` — type re-exports from `./tools/types`

'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CaretRightIcon } from '@/components/icons';
import type { ToolUseInfo, ToolResultInfo } from '@/types';
import { useTranslation } from '@/hooks/useTranslation';
import { computeSegments } from './tools/segments';
import {
  renderFlatActions,
  renderOrderedBody,
  getLastRunningToolAction,
  computeSegmentActionKeys,
} from './tools/flatRenderer';
import { formatDuration } from './tools/hooks/useTopLevelChrome';
import type { ToolAction, ActionItem } from './tools/types';
import type { AgentProgressEventWithMeta } from '@/hooks/useStreamingAgentProgress';

export type { ToolAction, ActionItem };

interface ToolActionsGroupProps {
  tools?: ToolAction[];
  actions?: ActionItem[];
  isStreaming?: boolean;
  streamingToolOutput?: string;
  flat?: boolean;
  thinkingContent?: string;
  agentProgressEvents?: AgentProgressEventWithMeta[];
  /** Full wall-clock duration from user question to final response.
   *  When provided, used in the summary in place of summed tool durations
   *  so the user sees the true response time (including model thinking). */
  totalDurationMs?: number | null;
  liveStartedAt?: number | null;
  /** Skip the collapsible summary toggle and always render the body
   *  expanded. Used in the sub-agent session view so every tool call
   *  shows inline (matching the main interface's expanded appearance)
   *  instead of hiding behind a "N tools · Worked for Xs" caret. */
  forceExpanded?: boolean;
}

export function ToolActionsGroup({
  tools,
  actions: actionsProp,
  isStreaming = false,
  streamingToolOutput,
  flat = false,
  thinkingContent,
  agentProgressEvents,
  totalDurationMs: totalDurationMsProp,
  liveStartedAt,
  forceExpanded = false,
}: ToolActionsGroupProps) {
  const { t } = useTranslation();
  // Build actions array from either new `actions` prop or legacy `tools` + `thinkingContent`
  const actions: ActionItem[] = React.useMemo(() => {
    if (actionsProp) return actionsProp;
    const result: ActionItem[] = [];
    if (thinkingContent) {
      result.push({ kind: 'thinking', content: thinkingContent, isStreaming });
    }
    for (const tool of (tools || [])) {
      result.push({ kind: 'tool', tool });
    }
    return result;
  }, [actionsProp, tools, thinkingContent, isStreaming]);

  const hasRunningTool = actions.some(
    (a) => a.kind === 'tool' && a.tool.result === undefined
  );
  // Always start collapsed once the round is done. We deliberately do
  // NOT remember a previous expansion via `userExpandedState` here —
  // a new round deserves a fresh, quiet state, and there's no user
  // expectation that one round's expansion leaks into the next.
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  // During streaming the body is rendered without a summary row, so
  // `expanded` is only meaningful for the collapsed-mode chrome. When
  // a round is mid-flight, force expanded so the body code-path stays
  // consistent (no one ever sees the summary, but the underlying
  // segmenter / renderOrderedBody output is the same).
  const expanded = userExpanded ?? (hasRunningTool || isStreaming);

  if (actions.length === 0) return null;

  const lastRunningTool = getLastRunningToolAction(actions);
  const segments = React.useMemo(() => computeSegments(actions), [actions]);
  const segmentActionKeys = React.useMemo(() => computeSegmentActionKeys(segments), [segments]);

  if (flat) {
    return (
      <div className="w-full">
        <div className="border-l-2 border-border/50">
          {/* For flat mode, interleave non-tool actions with the grouped
              tool segments so the visual order is preserved. */}
          {renderFlatActions(actions, segments, segmentActionKeys, isStreaming, streamingToolOutput, agentProgressEvents)}
        </div>
      </div>
    );
  }

  const totalDurationMs = React.useMemo(() => {
    // Prefer the explicit total duration (full response time) when provided.
    if (totalDurationMsProp != null && totalDurationMsProp > 0) {
      return totalDurationMsProp;
    }
    // Fall back to the sum of individual tool durations.
    let total = 0;
    for (const action of actions) {
      if (action.kind === 'tool' && action.tool.durationMs != null && action.tool.durationMs > 0) {
        total += action.tool.durationMs;
      }
    }
    return total;
  }, [actions, totalDurationMsProp]);

  // During the working phase we drop the entire chrome — no summary
  // button, no left border, no expand affordance. thinking / text /
  // tool rows stream out as plain prose. Group headers still wrap
  // runs of ≥2 tool calls but render collapsed by default.
  if (isStreaming) {
    return (
      <div className="w-full">
        <StreamingActionsBody
          actions={actions}
          segments={segments}
          lastRunningTool={lastRunningTool}
          streamingToolOutput={streamingToolOutput}
          agentProgressEvents={agentProgressEvents}
          isStreaming={isStreaming}
        />
      </div>
    );
  }

  // Force-expanded mode (sub-agent session view): skip the collapsible
  // summary toggle and render the body inline, matching the expanded
  // appearance of the main interface. Every tool call shows directly
  // instead of hiding behind a "N tools · Worked for Xs" caret.
  if (forceExpanded) {
    return (
      <div className="w-full">
        <div className="mt-0.5 border-l-2 border-border/50">
          {renderOrderedBody(actions, segments, lastRunningTool, streamingToolOutput, agentProgressEvents, isStreaming)}
        </div>
      </div>
    );
  }

  const toolCount = actions.reduce(
    (n, a) => (a.kind === 'tool' ? n + 1 : n),
    0,
  );
  const hasDuration = totalDurationMs > 0;
  const collapsedSummary = t('streaming.actions.completed', { count: toolCount }) +
    (hasDuration ? ` · ${t('streaming.actions.workedFor', { duration: formatDuration(totalDurationMs) })}` : '');

  const handleToggle = () => {
    setUserExpanded((prev) => prev !== null ? !prev : !expanded);
  };

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center gap-2 py-1 text-xs rounded-sm hover:bg-muted/30 transition-colors"
      >
        <span className="text-muted-foreground/60 truncate">
          {collapsedSummary}
        </span>

        <CaretRightIcon
          size={12}
          className={`shrink-0 text-muted-foreground/60 transition-transform duration-200 ml-auto ${expanded ? 'rotate-90' : ''}`}
        />
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            style={{ overflow: 'hidden', transformOrigin: 'top' }}
          >
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.12, ease: 'easeOut' }}
            >
              <div className="mt-0.5 border-l-2 border-border/50">
                {renderOrderedBody(actions, segments, lastRunningTool, streamingToolOutput, agentProgressEvents, isStreaming)}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * StreamingActionsBody — the un-chromed body used while the agent is
 * still working. It renders the same `renderOrderedBody` output the
 * collapsed-mode chrome would render when expanded, but with no
 * summary row above and no left border wrapping it. Group headers
 * inside still default to collapsed, so a stream of tool calls reads
 * as quiet "ran N tools" hint rows with the chat prose around them.
 */
function StreamingActionsBody({
  actions,
  segments,
  lastRunningTool,
  streamingToolOutput,
  agentProgressEvents,
  isStreaming,
}: {
  actions: ActionItem[];
  segments: ReturnType<typeof computeSegments>;
  lastRunningTool: ToolAction | undefined;
  streamingToolOutput?: string;
  agentProgressEvents?: AgentProgressEventWithMeta[];
  isStreaming: boolean;
}) {
  return (
    <div className="flex flex-col">
      {renderOrderedBody(actions, segments, lastRunningTool, streamingToolOutput, agentProgressEvents, isStreaming)}
    </div>
  );
}

export function pairTools(
  toolUses: ToolUseInfo[],
  toolResults: ToolResultInfo[]
): ToolAction[] {
  const resultMap = new Map<string, ToolResultInfo>();
  for (const r of toolResults) {
    resultMap.set(r.tool_use_id, r);
  }

  const paired: ToolAction[] = [];

  for (const t of toolUses) {
    const result = resultMap.get(t.id);
    paired.push({
      id: t.id,
      name: t.name,
      input: t.input,
      result: result?.content,
      isError: result?.is_error,
      durationMs: result?.duration_ms,
      metadata: result?.metadata,
    });
  }

  for (const r of toolResults) {
    if (!toolUses.some((u) => u.id === r.tool_use_id)) {
      paired.push({
        id: r.tool_use_id,
        name: 'tool_result',
        input: {},
        result: r.content,
        isError: r.is_error,
        durationMs: r.duration_ms,
        metadata: r.metadata,
      });
    }
  }

  return paired;
}
