// Group — generic single-line toggle for ≥2 consecutive tool calls.
//
// Header summarizes the group by category (commands / files / times /
// etc.), the expanded body lists each tool via ToolActionRow. The
// browser-fallback banner appears only when the group contains a
// browser tool running in fallback mode (extension not installed).

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
import type { ToolAction, ToolStatus } from '../types';

interface GroupProps {
  tools: ToolAction[];
  flat?: boolean;
  streamingToolOutput?: string;
  agentProgressEvents?: AgentProgressEventWithMeta[];
}

export function Group({
  tools,
  flat,
  streamingToolOutput,
  agentProgressEvents,
}: GroupProps) {
  const { t, locale } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);

  const hasRunning = tools.some((tool) => tool.result === undefined);
  const hasError = tools.some((tool) => tool.isError);
  const groupStatus: ToolStatus = hasRunning ? 'running' : hasError ? 'error' : 'success';
  const summaryText = buildGroupSummary(tools, t, locale);

  const containsBrowser = tools.some((tool) => isBrowserTool(tool.name));
  const showBrowserFallback = containsBrowser && isBrowserFallbackMode(tools);
  const lastRunningTool = tools.find((tool) => tool.result === undefined);

  // Re-render with a stable key based on the first tool's id so that
  // streaming updates (more tools added to the group) don't unmount the
  // whole subtree and re-trigger animations. Falls back to length when
  // ids are missing (e.g. legacy fixtures).
  const groupKey = `grp-${tools[0]?.id ?? 0}-${tools.length}`;

  // Group header hides the caret until hover, just like single rows.
  // No leading icon, no verb prefix — the summary text itself is a
  // complete sentence (e.g. "已运行 3 次命令，编辑 1 个文件") that
  // stands on its own.
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
    // In `flat` mode the group sits directly under the action list with
    // no chrome border; show the expanded body inline so the user can
    // see all tools at a glance (this matches the previous flat-mode
    // behavior for ContextGroup / BrowserGroup).
    return (
      <div key={groupKey} className="tool-group mt-1.5">
        {header}
        <div className="tool-group-body">
          {showBrowserFallback && <BrowserFallbackBanner />}
          {tools.map((tool, i) => (
            <GroupToolRow
              key={tool.id || `g-${i}`}
              tool={tool}
              streamingToolOutput={
                lastRunningTool?.id === tool.id ? streamingToolOutput : undefined
              }
              agentProgressEvents={agentProgressEvents}
            />
          ))}
        </div>
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
            <div className="tool-group-body">
              {showBrowserFallback && <BrowserFallbackBanner />}
              {tools.map((tool, i) => (
                <GroupToolRow
                  key={tool.id || `g-${i}`}
                  tool={tool}
                  streamingToolOutput={
                    lastRunningTool?.id === tool.id ? streamingToolOutput : undefined
                  }
                  agentProgressEvents={agentProgressEvents}
                />
              ))}
            </div>
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
