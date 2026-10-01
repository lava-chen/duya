// InvokeToolRow — renders tool_invoke calls (Plan 480) with per-source
// identity: a connector brand icon + "Used <App>" verb for connector /
// MCP / plugin tools, and the generic wrench for builtin deferred tools.
//
// Identity comes from the stable `tool_id` the model passes in
// (`connector:slack:post_message` etc. — see invoke-identity.ts), with the
// legacy Plan-480 draft `{ namespace, tool }` shape still accepted so older
// transcripts keep rendering. ZCode parity (ToolCallBlocks/renderers/mcp):
// the row names the *source* in the verb and the *action* as the summary,
// instead of dumping the raw envelope or a bare "invoke".
//
// Expanded body mirrors ZCode's MCP call details: the JSON arguments block
// first (an API-debugger view of what the model sent), then the standard
// ToolResultRenderer payload.

'use client';

import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AiGatewayIcon, WrenchIcon } from '@/components/icons';
import { ConnectorIcon } from '@/components/extensions/connector-icons';
import type { ProviderId } from '@/lib/app-connection-ipc';
import { useTranslation } from '@/hooks/useTranslation';
import { ActionRowChrome } from '../chrome/ActionRowChrome';
import { ToolStatusBadge } from '../statusBadge';
import { getStatus } from '../registry';
import { describeInvokeTool } from '../invoke-identity';
import type { ToolUseInfo, ToolResultInfo } from '@/types';
import { renderToolResult } from '../../ToolResultRenderer';
import type { TranslationKey } from '@/i18n';
import type { ToolAction } from '../types';

interface InvokeToolRowProps {
  tool: ToolAction;
}

export function InvokeToolRow({ tool }: InvokeToolRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const status = getStatus(tool);

  const hasResult = tool.result !== undefined && tool.result !== '';

  const { t } = useTranslation();
  const identity = describeInvokeTool(tool.input);
  const external =
    identity !== null && identity.kind !== 'builtin' && identity.sourceLabel !== '';

  const toolInfo: ToolUseInfo = {
    id: tool.id || '',
    name: tool.name,
    input: tool.input,
  };
  const resultInfo: ToolResultInfo = {
    tool_use_id: tool.id || '',
    content: tool.result || '',
    is_error: Boolean(tool.isError),
  };
  const renderedResult = hasResult ? renderToolResult(toolInfo, resultInfo) : null;
  const canExpand = hasResult && renderedResult !== null;

  // External sources name the app in the verb ("已使用 Slack"); builtin
  // deferred tools keep the plain invoke verbs. ZCode parity: the summary
  // slot carries the *action*, the verb slot carries the *source*.
  const verbText = identity && external
    ? t(
        status === 'running'
          ? 'streaming.toolAction.running.source'
          : status === 'error'
            ? 'streaming.toolAction.error.source'
            : 'streaming.toolAction.done.source',
        { source: identity.sourceLabel },
      )
    : undefined;
  const verbKey: TranslationKey | undefined = verbText
    ? undefined
    : status === 'running'
      ? 'streaming.toolAction.running.invoke'
      : status === 'error'
        ? 'streaming.toolAction.error.invoke'
        : 'streaming.toolAction.done.invoke';

  const icon = identity && external && identity.kind === 'connector'
    ? <ConnectorIcon provider={identity.sourceId as ProviderId} label={identity.sourceLabel} size={14} />
    : external
      ? <AiGatewayIcon size={14} />
      : <WrenchIcon size={14} />;

  const summary = identity ? identity.toolLabel : 'invoke';

  const args = (tool.input as { arguments?: unknown } | undefined)?.arguments;
  const hasArgs =
    args !== null && typeof args === 'object' && Object.keys(args as object).length > 0;

  return (
    <div>
      <ActionRowChrome
        status={status}
        verbKey={verbKey}
        verbText={verbText}
        icon={icon}
        canExpand={canExpand}
        expanded={expanded}
        hovered={hovered}
        durationMs={tool.durationMs}
        onClick={() => canExpand && setExpanded((prev) => !prev)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        buttonClassName={canExpand ? 'cursor-pointer' : 'cursor-default'}
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
              {hasArgs && (
                <pre className="mb-2 max-h-40 overflow-auto rounded-md bg-muted/40 p-2 text-[11px] leading-relaxed font-mono text-muted-foreground whitespace-pre-wrap break-words">
                  {JSON.stringify(args, null, 2)}
                </pre>
              )}
              {renderedResult}
              <ToolStatusBadge status={status} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
