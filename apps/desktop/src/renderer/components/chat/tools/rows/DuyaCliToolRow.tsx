// DuyaCliToolRow — handles the `duya_cli` tool (the agent invoking a
// duya subcommand). Mirrors BashToolRow's layout: collapsed chrome with
// the command line as the summary, expanded dark card with stdout
// surfaced and an exit-code-aware status badge. stderr is intentionally
// hidden from the card — failures are conveyed through the bottom
// badge instead.

'use client';

import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  CheckCircleIcon,
  SpinnerGapIcon,
  XCircleIcon,
} from '@/components/icons';
import { ActionRowChrome } from '../chrome/ActionRowChrome';
import { getStatus } from '../registry';
import { parseDuyaCliResult } from '../parseDuyaCliResult';
import type { ToolAction, ToolStatus } from '../types';

interface DuyaCliToolRowProps {
  tool: ToolAction;
}

export function DuyaCliToolRow({ tool }: DuyaCliToolRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const status = getStatus(tool);
  const hasResult = tool.result !== undefined && tool.result !== '';

  const argv = (tool.input as Record<string, unknown>)?.argv;
  const args = Array.isArray(argv) ? argv.map(String) : [];
  const cmd = args.length > 0 ? `duya ${args.join(' ')}` : 'duya';
  const isRunning = tool.result === undefined;
  const parsed = hasResult ? parseDuyaCliResult(tool.result) : null;
  const exitCode = parsed?.exitCode;
  const stdout = parsed?.stdout ?? '';
  const okFlag = parsed?.ok;
  // When tool marks failure via ok=false or non-zero exit, treat as error even
  // if isError flag is missing. stderr is intentionally hidden from the
  // card — the failure is conveyed through the bottom-right badge instead.
  const isError = tool.isError || okFlag === false || (exitCode !== undefined && exitCode !== 0);
  // The chrome picks its own status dot, so we override the status
  // field when the duya result implies an error that the `isError`
  // flag missed.
  const rowStatus: ToolStatus = isError ? 'error' : status;

  const verbKey =
    rowStatus === 'running' ? 'streaming.toolAction.running.cli'
    : rowStatus === 'error' ? 'streaming.toolAction.error.cli'
    : 'streaming.toolAction.done.cli';

  const hasStdout = !!stdout && stdout.trim().length > 0;

  return (
    <div>
      <ActionRowChrome
        status={rowStatus}
        verbKey={verbKey}
        canExpand
        expanded={expanded}
        hovered={hovered}
        durationMs={tool.durationMs}
        onClick={() => setExpanded((prev) => !prev)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {cmd}
      </ActionRowChrome>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div className="mx-1 my-1 rounded-lg tool-card p-3 relative">
              <div className="font-mono text-[13px] tool-card-subtle leading-relaxed">
                <span className="break-all">{cmd}</span>
              </div>

              {hasStdout && (
                <>
                  <div className="mt-2 mb-1.5" style={{ borderTop: '1px solid var(--tool-card-divider)' }} />
                  <div className="font-mono text-[12px] tool-card-subtle whitespace-pre-wrap break-all max-h-[150px] overflow-auto leading-relaxed">
                    {stdout}
                  </div>
                </>
              )}

              {!hasStdout && !isRunning && (
                <div className="text-[12px] tool-card-faint italic mt-2">No output</div>
              )}

              <div className="mt-1 flex justify-end">
                {status === 'running' && (
                  <div className="flex items-center gap-1 text-[11px] text-amber-500">
                    <SpinnerGapIcon size={12} className="animate-spin" />
                    <span>Running</span>
                  </div>
                )}
                {!isRunning && isError && (
                  <div className="flex items-center gap-1 text-[11px] text-red-500">
                    <XCircleIcon size={12} />
                    <span>{exitCode != null ? `Failed (exit ${exitCode})` : 'Failed'}</span>
                  </div>
                )}
                {!isRunning && !isError && (
                  <div className="flex items-center gap-1 text-[11px] text-green-500">
                    <CheckCircleIcon size={12} />
                    <span>Success</span>
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
