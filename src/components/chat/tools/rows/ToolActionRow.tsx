// ToolActionRow — router that decides which dedicated row file should
// render a given tool action. Each tool name family (bash, duya_cli,
// subagent, file edit/create, read, askuserquestion, memory, skill,
// read_module, task) routes to its own row file. Anything not handled
// by a dedicated row falls through to the generic renderer (which
// uses ToolResultRenderer to format the result payload).
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
  isModuleTool,
  isTaskToolAction,
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
import { SkillToolRow } from './SkillToolRow';
import { ModuleToolRow } from './ModuleToolRow';
import { TaskToolRow } from './TaskToolRow';

interface ToolActionRowProps {
  tool: ToolAction;
  streamingToolOutput?: string;
  agentProgressEvents?: AgentProgressEventWithMeta[];
}

export function ToolActionRow({ tool, streamingToolOutput, agentProgressEvents }: ToolActionRowProps) {
  const { t } = useTranslation();
  const renderer = getRenderer(tool.name);
  const filePath = getFilePath(tool.input);
  const status = getStatus(tool);
  const summary = renderer.getSummary(tool.input, tool.name);
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
  const isSkillTool = lowerName === 'skill';
  const isReadModule = isModuleTool(tool.name);
  // TaskTool uses the same tool name as the legacy subagent
  // dispatcher; the predicate inspects `input.action` to disambiguate.
  // Routing TaskTool here means TaskToolRow owns the chrome summary,
  // the JSON envelope body, and the drawer auto-open trigger.
  const isTaskTool = isTaskToolAction(tool.input);
  const [expanded, setExpanded] = useState(false);
  // Keep all useState calls before any conditional return so React hook
  // order stays stable when routing conditions change between renders.
  const [hovered, setHovered] = useState(false);

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

  if (isSkillTool) {
    // Skill row owns its own header (chrome), markdown rendering, and
    // base-directory path presentation. Routing here keeps the catch-all
    // path below from JSON-dumping the raw tool result envelope.
    return <SkillToolRow tool={tool} />;
  }

  if (isReadModule) {
    // ModuleTool (read_module) returns inlined design-spec READMEs as
    // joined markdown. Route to ModuleToolRow so the chrome summary
    // shows the loaded module names (e.g. "diagram + chart") instead
    // of the raw JSON input dump, and the expanded body renders the
    // markdown via MarkdownRenderer instead of the catch-all mono dump.
    return <ModuleToolRow tool={tool} />;
  }

  if (isTaskTool) {
    // TaskTool returns a JSON envelope `{ task: { id, subject } }`
    // (or `{ taskId, status, ... }` for update/output/stop). Route to
    // TaskToolRow so the chrome summary renders natural language
    // ("已创建 设计杂志风...") per-action and a successful create /
    // status=completed update auto-opens the TaskDrawer.
    return <TaskToolRow tool={tool} />;
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

  // Resolve the verb label through i18n. While running we use a
  // generic "Running…" label; once finished, the registry's noun
  // label (e.g. "Search", "Browser", "CLI") doubles as the past-tense
  // verb. Errors fall through to a generic "Failed" label so this
  // catch-all still reads naturally when the registry didn't supply a
  // dedicated row. (Skill tools route to their own row above and never
  // reach this branch.)
  const verbKey =
    status === 'running' ? 'streaming.toolAction.running.search'
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
