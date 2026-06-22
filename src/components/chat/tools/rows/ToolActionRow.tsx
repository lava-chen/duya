// ToolActionRow — router that decides which dedicated row file should
// render a given tool action. Each tool name family (bash, duya_cli,
// subagent, file edit/create, read, askuserquestion, memory) routes to
// its own row file. Anything not handled by a dedicated row falls
// through to the generic renderer (which uses ToolResultRenderer to
// format the result payload).
//
// This is the only place that knows about every dedicated row — adding
// a new tool = add a row file + one branch here + one entry in the
// registry, not a multi-line edit across chrome / group / row.

'use client';

import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  TerminalIcon,
  RobotIcon,
} from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import type { ToolUseInfo, ToolResultInfo } from '@/types';
import { renderToolResult } from '../../ToolResultRenderer';
import {
  isAskUserQuestionTool,
  isLegacySubAgentToolAction,
  FILE_CREATE_TOOLS,
  FILE_EDIT_TOOLS,
} from '../classify';
import { getRenderer, getStatus, getFilePath, truncatePath } from '../registry';
import { ActionRowChrome } from '../chrome/ActionRowChrome';
import { ToolStatusBadge } from '../statusBadge';
import type { AgentProgressEventWithMeta } from '@/hooks/useStreamingAgentProgress';
import type { ToolAction } from '../types';
import type { TranslationKey } from '@/i18n';
import { BashToolRow } from './BashToolRow';
import { DuyaCliToolRow } from './DuyaCliToolRow';
import { SubAgentToolRow } from './SubAgentToolRow';
import { FileEditToolRow } from './FileEditToolRow';
import { ReadToolRow } from './ReadToolRow';
import { AskUserQuestionResultRow } from './AskUserQuestionResultRow';
import { MemoryToolRow } from './MemoryToolRow';

interface ToolActionRowProps {
  tool: ToolAction;
  streamingToolOutput?: string;
  agentProgressEvents?: AgentProgressEventWithMeta[];
}

export function ToolActionRow({ tool, streamingToolOutput, agentProgressEvents }: ToolActionRowProps) {
  const { t } = useTranslation();
  const renderer = getRenderer(tool.name);
  // Skill tools pass through the catch-all renderer whose getSummary
  // dumps the input JSON. Override with the skill name so the chrome
  // shows a clean label like "news-investigator" instead of
  // `{"skill":"news-investigator"}`.
  const isSkillTool = tool.name.toLowerCase() === 'skill';
  const skillName = isSkillTool
    ? (() => {
        const inp = tool.input as Record<string, unknown> | undefined;
        const name = inp?.skill ?? inp?.name;
        return typeof name === 'string' && name.trim() ? name.trim() : 'skill';
      })()
    : null;
  const summary = isSkillTool && skillName
    ? skillName
    : renderer.getSummary(tool.input, tool.name);
  const filePath = getFilePath(tool.input);
  const status = getStatus(tool);
  const isDuyaCli = ['duya_cli', 'duya-cli', 'duyacli'].includes(tool.name.toLowerCase());
  const isBash = !isDuyaCli && renderer.icon === TerminalIcon;
  const lowerName = tool.name.toLowerCase();
  const isLegacySubAgent = isLegacySubAgentToolAction(tool);
  // AgentStatus used to route here as a separate path, but the tool
  // was removed in P0-γ. Subagent routing now solely relies on icon
  // + legacy alias detection.
  const isSubAgent = renderer.icon === RobotIcon || isLegacySubAgent;
  const isFileEdit = FILE_EDIT_TOOLS.has(lowerName) || FILE_CREATE_TOOLS.has(lowerName);
  const isRead = ['read', 'readfile', 'read_file'].includes(lowerName);
  const isAskUserQuestion = isAskUserQuestionTool(tool.name);
  const isMemory = lowerName === 'memory';
  const [expanded, setExpanded] = useState(false);

  if (isBash) {
    return <BashToolRow tool={tool} streamingToolOutput={streamingToolOutput} />;
  }

  if (isDuyaCli) {
    return <DuyaCliToolRow tool={tool} />;
  }

  if (isSubAgent) {
    return <SubAgentToolRow tool={tool} agentProgressEvents={agentProgressEvents} />;
  }

  if (isFileEdit) {
    return <FileEditToolRow tool={tool} />;
  }

  if (isRead) {
    return <ReadToolRow tool={tool} />;
  }

  if (isAskUserQuestion) {
    return <AskUserQuestionResultRow tool={tool} />;
  }

  if (isMemory) {
    return <MemoryToolRow tool={tool} />;
  }

  const hasResult = tool.result !== undefined && tool.result !== '';
  const isRunning = tool.result === undefined;

  // Build tool info for renderToolResult
  const toolInfo: ToolUseInfo = {
    id: tool.id || '',
    name: tool.name,
    input: tool.input,
  };

  const resultInfo: ToolResultInfo = {
    tool_use_id: tool.id || '',
    content: tool.result || '',
    is_error: tool.isError,
  };

  const renderedResult = hasResult ? renderToolResult(toolInfo, resultInfo) : null;
  const canExpand = hasResult && renderedResult !== null;
  const [hovered, setHovered] = useState(false);

  // Resolve the verb label through i18n. While running we use a
  // generic "Running…" label; once finished, the registry's noun
  // label (e.g. "Search", "Browser", "CLI") doubles as the past-tense
  // verb. Errors fall through to a generic "Failed" label so this
  // catch-all still reads naturally when the registry didn't supply a
  // dedicated row. Skill tools get dedicated verbs instead of dumping
  // the raw `{"skill":"name"}` JSON.
  const verbKey =
    isSkillTool
      ? (status === 'running' ? 'streaming.toolAction.running.skill'
      : status === 'error' ? 'streaming.toolAction.error.skill'
      : 'streaming.toolAction.done.skill')
      : status === 'running' ? 'streaming.toolAction.running.search'
      : status === 'error' ? 'streaming.toolAction.error.search'
      : renderer.labelKey ?? undefined;

  return (
    <div>
      <ActionRowChrome
        status={status}
        verbKey={verbKey as TranslationKey | undefined}
        canExpand={canExpand}
        expanded={expanded}
        hovered={hovered}
        durationMs={tool.durationMs}
        onClick={() => canExpand && setExpanded((prev) => !prev)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        buttonClassName={canExpand ? 'cursor-pointer' : 'cursor-default'}
        rightSlot={
          filePath ? (
            <span className="text-muted-foreground/40 text-[11px] font-mono truncate max-w-[200px] hidden sm:inline">
              {truncatePath(filePath)}
            </span>
          ) : null
        }
      >
        {summary}
      </ActionRowChrome>

      <AnimatePresence initial={false}>
        {expanded && canExpand && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div className="mx-1 my-1 rounded-lg tool-card p-3 relative">
              {renderedResult}
              <ToolStatusBadge status={status} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
