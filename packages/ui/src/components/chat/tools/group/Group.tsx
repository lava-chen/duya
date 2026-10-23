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
import { DiffStatBadge } from '../chrome/DiffStatBadge';
import { resolveGroupDisplayTitle } from './buildGroupDisplayTitle';
import { aggregateFileEditStats } from '../fileEditStats';
import { isBrowserFallbackMode } from '../registry';
import { isBrowserTool } from '../classify';
import { getExpansion, writeExpansion } from '../expansionStore';
import { ToolActionRow } from '../rows/ToolActionRow';
import { ThinkingRow } from '../rows/ThinkingRow';
import { HookActionRow } from '../rows/HookActionRow';
import type { SegmentEntry, ToolAction, ToolStatus } from '../types';

// Expansion state lives in the shared module-level store (see
// ../expansionStore) — keyed by the group's stable identity (first
// tool's id, or a positional fallback). This survives streaming
// updates that rebuild the `entries` array — the Group component
// re-renders with new entries but its `expanded` state is rehydrated
// from the store instead of resetting to false.
//
// Without this, when the agent is mid-flight and the user clicks to
// expand a group, the next streaming SSE event rebuilds the actions
// array, which rebuilds the segments, which can cause React to
// remount the Group subtree (new segment identity even though the
// logical group is the same) — losing the user's expansion state and
// forcing them to re-click.
const EXPANSION_SCOPE = 'group';

interface GroupProps {
  entries: SegmentEntry[];
  flat?: boolean;
  /**
   * `header` (default) — the group renders a summary header plus a
   * collapsible body. Used while the round is still streaming, where
   * the header is what folds a run of tool calls into one quiet line.
   *
   * `card` — the group renders ONLY its body, inside a bordered card.
   * Used by a finished round's expanded body: the round's own summary
   * line already carries the category verbs, so a second header row
   * would only repeat them (and cost the user two extra clicks).
   */
  variant?: 'header' | 'card';
  /** Whether the owning round's stream is still live. Gates the thinking
   *  rows' live shimmer/typewriter so they stop when the stream ends even
   *  if the entry's own flag was set while it was the trailing event. */
  streamLive?: boolean;
  streamingToolOutput?: string;
  agentProgressEvents?: AgentProgressEventWithMeta[];
}

export function Group({
  entries,
  flat,
  variant = 'header',
  streamLive,
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
  const displayTitle = resolveGroupDisplayTitle(
    tools.map((entry) => entry.tool),
    t,
    locale,
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
  const groupKey = `grp-${tools[0]?.tool.groupId ?? tools[0]?.tool.id ?? `idx0-${entries[0]?.kind ?? 'unknown'}`}`;

  // Rehydrate expansion state from the shared store. The lazy
  // initializer only runs on mount, so subsequent updates to the store
  // (from this or other Group instances) don't override local state.
  const [expanded, setExpanded] = useState(() => getExpansion(EXPANSION_SCOPE, groupKey) ?? false);
  const [hovered, setHovered] = useState(false);

  const toggleExpanded = () => {
    setExpanded((prev) => {
      const next = !prev;
      writeExpansion(EXPANSION_SCOPE, groupKey, next);
      return next;
    });
  };

  // Round-level diff stat for this group — summed from the same
  // per-row numbers the expanded rows show, so the header stat and the
  // rows underneath can never disagree. `entries` is the stable
  // identity of this group (the segment array is memoized upstream),
  // so the memo survives re-renders that rebuild `tools`.
  const diffStat = React.useMemo(
    () => aggregateFileEditStats(tools.map((entry) => entry.tool)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries],
  );

  const rows = entries.map((entry, i) =>
    entry.kind === 'tool' ? (
      <GroupToolRow
        key={entry.tool.id || `g-${i}`}
        tool={entry.tool}
        streamingToolOutput={
          lastRunningTool?.id === entry.tool.id ? streamingToolOutput : undefined
        }
        agentProgressEvents={agentProgressEvents}
      />
    ) : entry.kind === 'thinking' ? (
      <ThinkingRow
        key={`thinking-${i}`}
        content={entry.content}
        isStreaming={!!streamLive && !!entry.isStreaming}
      />
    ) : (
      // Plan 437: hook entries route through HookActionRow, which
      // reuses the shared ActionRowChrome so the group body stays
      // visually uniform.
      <HookActionRow key={entry.hook.id || `hook-${i}`} hook={entry.hook} />
    )
  );

  const body = (
    <div className="tool-group-body">
      {showBrowserFallback && <BrowserFallbackBanner />}
      {rows}
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
      rightSlot={
        <DiffStatBadge additions={diffStat.additions} removals={diffStat.removals} />
      }
    >
      <span data-title-source={displayTitle.source}>{displayTitle.title}</span>
    </ActionRowChrome>
  );

  if (variant === 'card') {
    // The card variant drops the header row, but the header carried one
    // thing the round line does NOT have: the model's own semantic
    // title for this run of calls ("Ran architecture gate"). The
    // generic category summary is dropped — the round line already
    // shows it — while a real progress title survives as a quiet
    // label on top of the card.
    const semanticTitle =
      displayTitle.source === 'tool_fallback' ? null : displayTitle.title;
    return (
      <div key={groupKey} className="tool-round-card mt-1.5">
        {semanticTitle && (
          <div className="tool-round-card__label">
            <span data-title-source={displayTitle.source} className="truncate">
              {semanticTitle}
            </span>
          </div>
        )}
        {showBrowserFallback && <BrowserFallbackBanner />}
        {rows}
      </div>
    );
  }

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
