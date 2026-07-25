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
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);

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

  // Re-render with a stable key based on the first tool's id so that
  // streaming updates (more entries added to the group) don't unmount
  // the whole subtree and re-trigger animations. Falls back to length
  // when ids are missing (e.g. legacy fixtures). Length uses
  // `entries.length` not `tools.length` because thinking entries
  // count toward the streaming-visible group size even though they
  // don't contribute to the header summary.
  const groupKey = `grp-${tools[0]?.tool.id ?? 0}-${entries.length}`;

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
      onClick={() => setExpanded((prev) => !prev)}
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