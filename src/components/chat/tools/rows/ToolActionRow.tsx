// ToolActionRow — router that decides which dedicated row file should
// render a given tool action. Each tool name family (bash, duya_cli,
// subagent, file edit/create, read, askuserquestion, skill,
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
  isMessageSessionTool,
  isModuleTool,
  isTaskToolAction,
  FILE_CREATE_TOOLS,
  FILE_EDIT_TOOLS,
} from '../classify';
import { getRenderer, getStatus, getFilePath, truncatePath } from '../registry';
import { ActionRowChrome } from '../chrome/ActionRowChrome';
import { ToolStatusBadge } from '../statusBadge';
import type { AgentProgressEventWithMeta } from '@/hooks/useStreamingAgentProgress';
import type { ToolAction, ToolRendererDef } from '../types';
import type { TranslationKey } from '@/i18n';
import { BashToolRow } from './BashToolRow';
import { DuyaCliToolRow } from './DuyaCliToolRow';
import { SubAgentToolRow } from './SubAgentToolRow';
import { FileEditToolRow } from './FileEditToolRow';
import { ReadToolRow } from './ReadToolRow';
import { AskUserQuestionResultRow } from './AskUserQuestionResultRow';
import { MessageSessionToolRow } from './MessageSessionToolRow';
import { SkillToolRow } from './SkillToolRow';
import { ModuleToolRow } from './ModuleToolRow';
import { TaskToolRow } from './TaskToolRow';
import { VisionToolRow } from './VisionToolRow';
import { CanvasConductorToolRow } from './CanvasConductorToolRow';

interface ToolActionRowProps {
  tool: ToolAction;
  streamingToolOutput?: string;
  agentProgressEvents?: AgentProgressEventWithMeta[];
}

// Ordered route table for dedicated tool rows. Adding a new dedicated
// row = add one entry here + create the row file. The order matters
// because some predicates overlap (e.g. `task` name is shared by
// TaskTool and legacy subagent dispatch — TaskTool must be checked
// before SubAgent, and SubAgent's legacy detection explicitly excludes
// `isTaskToolAction`).
//
// Each entry's `match` receives the full tool plus the precomputed
// registry renderer so it can combine name + icon + input checks in
// a single predicate (previously these were scattered across 16
// inline if branches with duplicated lowerName / lowerName chains).
interface RouteEntry {
  match: (tool: ToolAction, renderer: ToolRendererDef) => boolean;
  render: (tool: ToolAction, props: ToolActionRowProps) => React.ReactNode;
}

const ROUTES: RouteEntry[] = [
  {
    // duya_cli must be checked BEFORE Bash because both use
    // TerminalIcon. The Bash route below excludes duya_cli by name.
    match: (t) => ['duya_cli', 'duya-cli', 'duyacli'].includes(t.name.toLowerCase()),
    render: (tool) => <DuyaCliToolRow tool={tool} />,
  },
  {
    // Bash / shell — TerminalIcon but NOT duya_cli (excluded above by
    // the earlier route entry). The explicit name check here is a
    // safety net in case the route order is ever shuffled.
    match: (t, r) => r.icon === TerminalIcon
      && !['duya_cli', 'duya-cli', 'duyacli'].includes(t.name.toLowerCase()),
    render: (tool, p) => <BashToolRow tool={tool} streamingToolOutput={p.streamingToolOutput} />,
  },
  {
    // SubAgent — RobotIcon, or legacy `task` tool without `input.action`
    // (isLegacySubAgentToolAction internally excludes isTaskToolAction).
    match: (t, r) => r.icon === RobotIcon || isLegacySubAgentToolAction(t),
    render: (tool, p) => <SubAgentToolRow tool={tool} agentProgressEvents={p.agentProgressEvents} />,
  },
  {
    match: (t) => FILE_EDIT_TOOLS.has(t.name.toLowerCase()) || FILE_CREATE_TOOLS.has(t.name.toLowerCase()),
    render: (tool) => <FileEditToolRow tool={tool} />,
  },
  {
    match: (t) => ['read', 'readfile', 'read_file'].includes(t.name.toLowerCase()),
    render: (tool) => <ReadToolRow tool={tool} />,
  },
  {
    match: (t) => isAskUserQuestionTool(t.name),
    render: (tool) => <AskUserQuestionResultRow tool={tool} />,
  },
  {
    // Skill row owns its own header (chrome), markdown rendering, and
    // base-directory path presentation. Routing here keeps the catch-all
    // path below from JSON-dumping the raw tool result envelope.
    match: (t) => t.name.toLowerCase() === 'skill',
    render: (tool) => <SkillToolRow tool={tool} />,
  },
  {
    // ModuleTool (read_module) returns inlined design-spec READMEs as
    // joined markdown. Route to ModuleToolRow so the chrome summary
    // shows the loaded module names (e.g. "diagram + chart") instead
    // of the raw JSON input dump, and the expanded body renders the
    // markdown via MarkdownRenderer instead of the catch-all mono dump.
    match: (t) => isModuleTool(t.name),
    render: (tool) => <ModuleToolRow tool={tool} />,
  },
  {
    // TaskTool returns a JSON envelope `{ task: { id, subject } }`
    // (or `{ taskId, status, ... }` for update/output/stop). Route to
    // TaskToolRow so the chrome summary renders natural language
    // ("已创建 设计杂志风...") per-action. Must be checked before the
    // catch-all because the tool name `task` is shared with legacy
    // subagent dispatch (handled above by SubAgent route).
    match: (t) => isTaskToolAction(t.input),
    render: (tool) => <TaskToolRow tool={tool} />,
  },
  {
    // MessageSession returns a plain-text response from the target
    // agent, optionally followed by a "[Target agent used tools: ...]"
    // trailer. Route to MessageSessionToolRow so the chrome summary
    // shows the short target id + message preview instead of the raw
    // JSON dump, and the expanded body renders the response text +
    // tool-call summary + status badge.
    match: (t) => isMessageSessionTool(t.name),
    render: (tool) => <MessageSessionToolRow tool={tool} />,
  },
  {
    // vision_analyze returns a plain-text envelope ("Image analyzed:
    // <path>\nFormat: …\n[Question: …]\n\n<analysis>") plus an image
    // data URL in metadata. Route to VisionToolRow so the chrome
    // shows a status-aware verb ("已调用视觉能力" / "Used vision")
    // and a small preview card with the analyzed image; clicking
    // opens the full analysis in ToolImagePreviewModal.
    match: (t) => t.name.toLowerCase() === 'vision_analyze',
    render: (tool) => <VisionToolRow tool={tool} />,
  },
  {
    // Canvas Conductor tools (canvas_*) are rendered by a dedicated
    // row that maps each tool to a per-action verb and summary so the
    // user sees "正在绘制画布元素" instead of the raw JSON payload.
    match: (t) => t.name.toLowerCase().startsWith('canvas_') || t.name.toLowerCase() === 'database_manage',
    render: (tool) => <CanvasConductorToolRow tool={tool} />,
  },
];

export function ToolActionRow({ tool, streamingToolOutput, agentProgressEvents }: ToolActionRowProps) {
  const { t } = useTranslation();
  const renderer = getRenderer(tool.name);
  const filePath = getFilePath(tool.input);
  const status = getStatus(tool);
  const summary = renderer.getSummary(tool.input, tool.name);
  const [expanded, setExpanded] = useState(false);
  // Keep all useState calls before any conditional return so React hook
  // order stays stable when routing conditions change between renders.
  const [hovered, setHovered] = useState(false);

  // Try each dedicated route in order. The first match wins. Route
  // predicates are self-contained (each handles its own exclusions)
  // so the loop body is a plain first-match-wins lookup.
  for (const route of ROUTES) {
    if (route.match(tool, renderer)) {
      return <>{route.render(tool, { tool, streamingToolOutput, agentProgressEvents })}</>;
    }
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
