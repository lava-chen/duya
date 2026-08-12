// McpToolRow — handles MCP-provided tools. Any tool whose name starts
// with the `mcp_` provider prefix (see computeProviderName in
// packages/plugin-core/src/mcp/provider-tool-name.ts) is an external
// MCP tool, so the row surfaces it with the integrated AiGateway icon
// and the *MCP server name* (one server exposes many tools) instead of
// dumping the raw envelope like the generic catch-all.
//
// Row:  [gateway icon] [已使用/Used] [mcp server name]   [duration] [dot]
// Expanded body reuses the standard ToolResultRenderer so the payload
// keeps the same formatting as every other tool result.

'use client';

import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AiGatewayIcon } from '@/components/icons';
import { ActionRowChrome } from '../chrome/ActionRowChrome';
import { ToolStatusBadge } from '../statusBadge';
import { getStatus } from '../registry';
import type { ToolUseInfo, ToolResultInfo } from '@/types';
import { renderToolResult } from '../../ToolResultRenderer';
import type { TranslationKey } from '@/i18n';
import type { ToolAction } from '../types';

interface McpToolRowProps {
  tool: ToolAction;
}

/** Strip the `mcp_` provider prefix and the per-tool suffix so the
 *  chrome shows the *MCP server name* rather than one of its many tool
 *  names. An MCP server exposes many tools that all share the same
 *  provider prefix (`mcp_<server>_<toolName>`), so for
 *  `mcp_lit_add_source` we surface `lit` — not `add_source`.
 *  Falls back to the original name when the prefix is absent. */
export function displayMcpServerName(name: string): string {
  if (!name.toLowerCase().startsWith('mcp_')) return name;
  const rest = name.slice('mcp_'.length);
  const lastSep = rest.lastIndexOf('_');
  return lastSep !== -1 ? rest.slice(0, lastSep) : rest;
}

export function McpToolRow({ tool }: McpToolRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const status = getStatus(tool);

  const hasResult = tool.result !== undefined && tool.result !== '';

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

  const verbKey =
    status === 'running' ? 'streaming.toolAction.running.mcp'
    : status === 'error' ? 'streaming.toolAction.error.mcp'
    : 'streaming.toolAction.done.mcp';

  const name = displayMcpServerName(tool.name);

  return (
    <div>
      <ActionRowChrome
        status={status}
        verbKey={verbKey as TranslationKey}
        icon={<AiGatewayIcon size={14} />}
        canExpand={canExpand}
        expanded={expanded}
        hovered={hovered}
        durationMs={tool.durationMs}
        onClick={() => canExpand && setExpanded((prev) => !prev)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        buttonClassName={canExpand ? 'cursor-pointer' : 'cursor-default'}
      >
        {name}
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