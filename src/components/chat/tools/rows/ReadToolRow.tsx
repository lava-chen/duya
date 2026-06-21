// ReadToolRow — handles the `read` tool (and `readfile` / `read_file`
// aliases). The collapsed chrome shows the filename as the summary and
// the parsed line range (`L12-45`) in the right slot. The expanded body
// defers to ToolResultRenderer for the formatted result body.

'use client';

import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  CheckCircleIcon,
  SpinnerGapIcon,
  XCircleIcon,
} from '@/components/icons';
import { ActionRowChrome } from '../chrome/ActionRowChrome';
import { getStatus, getFilePath } from '../registry';
import { renderToolResult } from '../../ToolResultRenderer';
import type { ToolUseInfo, ToolResultInfo } from '@/types';
import type { ToolAction } from '../types';

interface ReadToolRowProps {
  tool: ToolAction;
}

/** Parse a `File: …\nLines: N-M\n\n` preamble from the read tool
 *  result. Returns null when the result has no preamble (older / non-
 *  standard formats). */
function parseReadLineRange(result: string): { start: number; end: number } | null {
  if (!result) return null;
  const match = result.match(/^File:\s*.+?\s*\nLines:\s*(\d+)-(\d+)\s*\n\n/);
  if (match) {
    return { start: parseInt(match[1]), end: parseInt(match[2]) };
  }
  return null;
}

export function ReadToolRow({ tool }: ReadToolRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const filePath = getFilePath(tool.input);
  const fileName = filePath.split(/[/\\]/).pop() || filePath;
  const status = getStatus(tool);
  const hasResult = tool.result !== undefined && tool.result !== '';

  // Parse line range from result
  const lineRange = hasResult ? parseReadLineRange(tool.result!) : null;

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

  const verbKey =
    status === 'running' ? 'streaming.toolAction.running.read'
    : status === 'error' ? 'streaming.toolAction.error.read'
    : 'streaming.toolAction.done.read';

  return (
    <div>
      <ActionRowChrome
        status={status}
        verbKey={verbKey}
        canExpand={hasResult}
        expanded={expanded}
        hovered={hovered}
        durationMs={tool.durationMs}
        onClick={() => hasResult && setExpanded((prev) => !prev)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        buttonClassName={hasResult ? 'cursor-pointer' : 'cursor-default'}
        rightSlot={
          lineRange ? (
            <span className="text-[11px] text-muted-foreground/50 tabular-nums shrink-0 font-mono">
              L{lineRange.start}-{lineRange.end}
            </span>
          ) : null
        }
      >
        {fileName}
      </ActionRowChrome>

      <AnimatePresence initial={false}>
        {expanded && hasResult && renderedResult && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div className="mx-1 my-1 rounded-lg tool-card p-3 relative">
              {renderedResult}

              {/* Status badge - bottom right */}
              <div className="mt-1 flex justify-end">
                {status === 'success' && (
                  <div className="flex items-center gap-1 text-[11px] text-green-500">
                    <CheckCircleIcon size={12} />
                    <span>Success</span>
                  </div>
                )}
                {status === 'error' && (
                  <div className="flex items-center gap-1 text-[11px] text-red-500">
                    <XCircleIcon size={12} />
                    <span>Failed</span>
                  </div>
                )}
                {status === 'running' && (
                  <div className="flex items-center gap-1 text-[11px] text-amber-500">
                    <SpinnerGapIcon size={12} className="animate-spin" />
                    <span>Running</span>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
