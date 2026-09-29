// InvokeToolRow — handles tool_invoke calls for MCP and other namespace-based
// tools. When the namespace is NOT 'builtin', the tool is rendered with the
// AiGateway icon and the namespace as the server name (one namespace exposes
// many tools). When the namespace IS 'builtin', it falls back to the generic
// catch-all renderer.
//
// This mirrors McpToolRow's visual treatment for tools invoked via
// tool_invoke (Plan 480) where MCP tools are no longer exposed as
// individual `mcp_<server>_<tool>` names but dispatched through the
// generic invoke meta-tool.

'use client';

import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AiGatewayIcon, WrenchIcon } from '@/components/icons';
import { ActionRowChrome } from '../chrome/ActionRowChrome';
import { ToolStatusBadge } from '../statusBadge';
import { getStatus } from '../registry';
import type { ToolUseInfo, ToolResultInfo } from '@/types';
import { renderToolResult } from '../../ToolResultRenderer';
import type { TranslationKey } from '@/i18n';
import type { ToolAction } from '../types';

interface InvokeToolRowProps {
  tool: ToolAction;
}

/** Builtin tools namespace — these are not MCP servers. */
const BUILTIN_NAMESPACE = 'builtin';

interface InvokeInput {
  namespace?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
}

export function InvokeToolRow({ tool }: InvokeToolRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const status = getStatus(tool);

  const hasResult = tool.result !== undefined && tool.result !== '';

  const input = tool.input as InvokeInput | undefined;
  const namespace = input?.namespace || '';
  const isMcp = namespace !== BUILTIN_NAMESPACE;

  // For MCP, the namespace IS the server name. For builtin, use tool name.
  const displayName = isMcp ? namespace : (input?.tool || 'invoke');

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

  // For MCP, use the MCP verb keys and icon. For builtin, use generic keys.
  const verbKey = isMcp
    ? status === 'running'
      ? 'streaming.toolAction.running.mcp'
      : status === 'error'
        ? 'streaming.toolAction.error.mcp'
        : 'streaming.toolAction.done.mcp'
    : status === 'running'
      ? 'streaming.toolAction.running.invoke'
      : status === 'error'
        ? 'streaming.toolAction.error.invoke'
        : 'streaming.toolAction.done.invoke';

  const icon = isMcp ? <AiGatewayIcon size={14} /> : <WrenchIcon size={14} />;

  return (
    <div>
      <ActionRowChrome
        status={status}
        verbKey={verbKey as TranslationKey}
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
        {displayName}
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
