// ResearchReportStatusRow — a plain, non-expandable status row for the
// `research_report` tool action (plan 423). The actual report renders as a
// standalone card at the end of the reply (ResearchReportCard); this row just
// signals that the research run was finalized, so it never expands and never
// duplicates the document body.

'use client';

import React from 'react';
import { ActionRowChrome } from '../chrome/ActionRowChrome';
import { getStatus } from '../registry';
import type { ToolAction } from '../types';

interface ResearchReportStatusRowProps {
  tool: ToolAction;
}

export function ResearchReportStatusRow({ tool }: ResearchReportStatusRowProps) {
  const status = getStatus(tool);
  const summary = 'Research report finalized';
  const verbKey =
    status === 'running' ? 'streaming.toolAction.running.module'
    : status === 'error' ? 'streaming.toolAction.error.module'
    : 'streaming.toolAction.done.module';

  return (
    <ActionRowChrome
      status={status}
      verbKey={verbKey}
      canExpand={false}
      expanded={false}
      hovered={false}
      durationMs={tool.durationMs}
    >
      {summary}
    </ActionRowChrome>
  );
}