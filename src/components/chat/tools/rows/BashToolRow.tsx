// BashToolRow — handles `bash` / `shell` / `execute` / `run` and their
// aliases. The chrome hides the leading verb (no "已运行" / "Ran"
// prefix) because the command itself is the most useful label. While
// running we tick a local 1-second interval so the duration label
// updates live; once the tool returns we fall back to the
// backend-supplied `tool.durationMs`.

'use client';

import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  CheckCircleIcon,
  CopyIcon,
  SpinnerGapIcon,
  XCircleIcon,
} from '@/components/icons';
import { ActionRowChrome } from '../chrome/ActionRowChrome';
import { getStatus } from '../registry';
import type { ToolAction, ToolStatus } from '../types';

interface BashToolRowProps {
  tool: ToolAction;
  streamingToolOutput?: string;
}

export function BashToolRow({ tool, streamingToolOutput }: BashToolRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [hovered, setHovered] = useState(false);
  const rawCmd = (tool.input as Record<string, unknown>)?.command || '';
  const cmd = typeof rawCmd === 'string' ? rawCmd : JSON.stringify(rawCmd);
  const isRunning = tool.result === undefined;
  const outputText = isRunning ? streamingToolOutput : tool.result;
  const status = getStatus(tool);
  // Distinguish shell tool vs bash tool: shellTool -> "Shell", bashTool -> "Bash".
  const shellLabel = tool.name.toLowerCase() === 'shell' ? 'Shell' : 'Bash';

  // Wall-clock moment we first saw this tool_use block in the stream.
  // The ref is set once on mount and never reset, so the live tick
  // counts up from "we started watching this command" rather than the
  // current render. The few hundred ms drift between actual tool start
  // and React mount is invisible at the second-resolution display.
  const startedAtRef = useRef<number>(Date.now());
  // Live tick — while the tool is still running, recompute elapsed ms
  // every second so the header's "已持续 2s" label updates in real time.
  // When the result lands the backend-supplied `tool.durationMs` takes
  // over and the interval is torn down.
  const [liveDurationMs, setLiveDurationMs] = useState<number>(
    () => Date.now() - startedAtRef.current,
  );
  useEffect(() => {
    if (!isRunning) return undefined;
    const tick = () => setLiveDurationMs(Date.now() - startedAtRef.current);
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [isRunning]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  // Per-state verb: "正在运行…" while the tool is alive, "已运行"
  // once it returns. Error state falls back to a generic failure
  // label — bash doesn't carry a domain-specific error verb.
  const verbKey =
    status === 'running' ? 'streaming.toolAction.running.bash'
    : status === 'error' ? 'streaming.toolAction.error.bash'
    : 'streaming.toolAction.ranCommand';

  // Live duration while running, otherwise the backend-supplied
  // duration (BashToolRow is the only row that ticks on its own).
  const displayDurationMs = isRunning
    ? liveDurationMs
    : tool.durationMs ?? null;

  const displayLines = (() => {
    if (!outputText) return null;
    if (isRunning) {
      const lines = outputText.split('\n');
      return lines.slice(-5).join('\n');
    }
    const lines = outputText.split('\n');
    if (lines.length > 20) {
      return lines.slice(0, 20).join('\n') + `\n… +${lines.length - 20} lines`;
    }
    return outputText;
  })();

  return (
    <div>
      <ActionRowChrome
        status={status}
        verbKey={verbKey}
        canExpand
        expanded={expanded}
        hovered={hovered}
        durationMs={displayDurationMs}
        onClick={() => setExpanded((prev) => !prev)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <span title={cmd}>{cmd}</span>
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
              {/* Shell label */}
              <div className="text-[11px] tool-card-muted font-medium mb-1.5">{shellLabel}</div>

              {/* Command with copy button */}
              <div className="group relative font-mono text-[13px] tool-card-subtle leading-relaxed pr-7">
                <span className="tool-card-muted mr-1.5 select-none">$</span>
                <span className="break-all">{cmd}</span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleCopy(); }}
                  className="absolute right-0 top-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded tool-card-faint hover:tool-card-subtle hover:bg-black/5 dark:hover:bg-white/5"
                  title="Copy command"
                >
                  {copied ? <CheckCircleIcon size={14} className="text-green-500" /> : <CopyIcon size={14} />}
                </button>
              </div>

              {/* Output */}
              {displayLines ? (
                <div className="font-mono text-[12px] tool-card-muted whitespace-pre-wrap break-all max-h-[150px] overflow-auto leading-relaxed mt-1.5">
                  {displayLines}
                </div>
              ) : (
                <div className="text-[12px] tool-card-faint italic mt-1.5">No output</div>
              )}

              {/* Status badge - bottom right */}
              <div className="mt-1 flex justify-end">
                <BottomBadge status={status} />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function BottomBadge({ status }: { status: ToolStatus }) {
  return (
    <>
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
    </>
  );
}
