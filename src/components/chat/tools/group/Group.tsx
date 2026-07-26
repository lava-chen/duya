// Group — generic single-line toggle for ≥2 consecutive tool / thinking
// actions. The header summarises the group by tool category
// (commands / files / times / etc.); the expanded body lists each
// entry in its original action order — tool rows are rendered through
// `ToolActionRow`, thinking rows through `ThinkingRow`. The browser-
// fallback banner only appears when the group contains a browser tool
// running in fallback mode.

'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from '@/hooks/useTranslation';
import type { AgentProgressEventWithMeta } from '@/hooks/useStreamingAgentProgress';
import { ActionRowChrome } from '../chrome/ActionRowChrome';
import { buildGroupSummary } from './buildGroupSummary';
import { isBrowserFallbackMode } from '../registry';
import { isBrowserTool } from '../classify';
import { ToolActionRow } from '../rows/ToolActionRow';
import { ThinkingRow } from '../rows/ThinkingRow';
import type { SegmentEntry, ToolAction, ToolStatus } from '../types';

// Module-level expansion-state store. Keyed by the group's stable
// identity (first tool's id, or a positional fallback). This survives
// streaming updates that rebuild the `entries` array — the Group
// component re-renders with new entries but its `expanded` state is
// rehydrated from this Map instead of resetting to false.
//
// Without this, when the agent is mid-flight and the user clicks to
// expand a group, the next streaming SSE event rebuilds the actions
// array, which rebuilds the segments, which can cause React to
// remount the Group subtree (new segment identity even though the
// logical group is the same) — losing the user's expansion state and
// forcing them to re-click.
//
// The Map is bounded to prevent unbounded growth across a long
// session; when it exceeds the limit the oldest entry is evicted
// (Map preserves insertion order in JS).
const GROUP_EXPANSION_LIMIT = 500;
const groupExpansionState = new Map<string, boolean>();

function getGroupExpansion(key: string): boolean {
  return groupExpansionState.get(key) ?? false;
}

function setGroupExpansion(key: string, value: boolean): void {
  if (groupExpansionState.size >= GROUP_EXPANSION_LIMIT) {
    const firstKey = groupExpansionState.keys().next().value;
    if (firstKey !== undefined) groupExpansionState.delete(firstKey);
  }
  groupExpansionState.set(key, value);
}

interface GroupProps {
  entries: SegmentEntry[];
  flat?: boolean;
  streamingToolOutput?: string;
  agentProgressEvents?: AgentProgressEventWithMeta[];
}

export function Group({
  entries,
  flat,
  streamingToolOutput,
  agentProgressEvents,
}: GroupProps) {
  const { t, locale } = useTranslation();

  // Tool-only subset. Thinking rows are not counted toward the header
  // summary — they're a side-channel of the model's reasoning, not a
  // separate user-visible step that deserves "已思考 N 次".
  const tools = entries.filter(
    (e): e is Extract<SegmentEntry, { kind: 'tool' }> => e.kind === 'tool'
  );
  const hasRunning = tools.some((entry) => entry.tool.result === undefined);
  const hasError = tools.some((entry) => entry.tool.isError);
  const groupStatus: ToolStatus = hasRunning ? 'running' : hasError ? 'error' : 'success';
  const summaryText = buildGroupSummary(
    tools.map((entry) => entry.tool),
    t,
    locale
  );

  const containsBrowser = tools.some((entry) => isBrowserTool(entry.tool.name));
  const showBrowserFallback = containsBrowser && isBrowserFallbackMode(
    tools.map((entry) => entry.tool)
  );
  const lastRunningTool = tools.find((entry) => entry.tool.result === undefined)
    ?.tool;

  // Stable key based on the first tool's id so streaming updates
  // (more entries added to the group) don't unmount the whole
  // subtree and re-trigger animations. The key must NOT depend on
  // `entries.length` or `tools.length` — those change as streaming
  // appends entries. When the first tool id is missing (legacy
  // fixtures), fall back to a positional key derived from the first
  // entry kind so siblings still disambiguate.
  //
  // This key is also used to persist expansion state in the
  // module-level Map above — computed before useState so the lazy
  // initializer can read the persisted value.
  const groupKey = `grp-${tools[0]?.tool.id ?? `idx0-${entries[0]?.kind ?? 'unknown'}`}`;

  // Rehydrate expansion state from the module-level Map. The lazy
  // initializer only runs on mount, so subsequent updates to the Map
  // (from this or other Group instances) don't override local state.
  const [expanded, setExpanded] = useState(() => getGroupExpansion(groupKey));
  const [hovered, setHovered] = useState(false);

  const toggleExpanded = () => {
    setExpanded((prev) => {
      const next = !prev;
      setGroupExpansion(groupKey, next);
      return next;
    });
  };

  const body = (
    <div className="tool-group-body">
      {showBrowserFallback && <BrowserFallbackBanner />}
      {entries.map((entry, i) =>
        entry.kind === 'tool' ? (
          <GroupToolRow
            key={entry.tool.id || `g-${i}`}
            tool={entry.tool}
            streamingToolOutput={
              lastRunningTool?.id === entry.tool.id ? streamingToolOutput : undefined
            }
            agentProgressEvents={agentProgressEvents}
          />
        ) : (
          <ThinkingRow
            key={`thinking-${i}`}
            content={entry.content}
            isStreaming={entry.isStreaming}
          />
        )
      )}
    </div>
  );

  const header = (
    <ActionRowChrome
      status={groupStatus}
      verbKey={undefined}
      canExpand
      expanded={expanded}
      hovered={hovered}
      onClick={toggleExpanded}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {summaryText}
    </ActionRowChrome>
  );

  if (flat) {
    return (
      <div key={groupKey} className="tool-group mt-1.5">
        {header}
        {body}
      </div>
    );
  }

  return (
    <div key={groupKey} className="tool-group mt-1.5">
      {header}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            style={{ overflow: 'hidden' }}
          >
            {body}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function BrowserFallbackBanner() {
  const { t } = useTranslation();
  return (
    <div className="tool-group-fallback">
      <span className="font-medium text-[11px] text-amber-500">
        {t('streaming.toolAction.fallbackTitle')}
      </span>
      <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
        {t('streaming.toolAction.fallbackDesc')}
      </p>
    </div>
  );
}

function GroupToolRow({
  tool,
  streamingToolOutput,
  agentProgressEvents,
}: {
  tool: ToolAction;
  streamingToolOutput?: string;
  agentProgressEvents?: AgentProgressEventWithMeta[];
}) {
  return (
    <ToolActionRow
      tool={tool}
      streamingToolOutput={streamingToolOutput}
      agentProgressEvents={agentProgressEvents}
    />
  );
}