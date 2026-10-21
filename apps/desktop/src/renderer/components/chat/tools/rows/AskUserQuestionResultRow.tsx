// AskUserQuestionResultRow — handles the `AskUserQuestion` tool. The
// result string is the LLM-facing format produced by
// AskUserQuestionTool.formatAnswersForLLM():
//   User has answered your questions: "Q1"="A1", "Q2"="A2". You can now ...
//
// The expanded card parses the "Q"="A" pairs and renders each answer
// in green so the user can scan which questions they answered at a
// glance. On parse failure we fall back to rendering the raw result
// text inside the same dark card.

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
import type { ToolAction } from '../types';

interface AskUserQuestionResultRowProps {
  tool: ToolAction;
}

export function AskUserQuestionResultRow({ tool }: AskUserQuestionResultRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const status = getStatus(tool);
  const summary = (() => {
    const inp = (tool.input || {}) as Record<string, unknown>;
    const firstQ = (inp.questions as Array<{ question?: string }> | undefined)?.[0];
    return firstQ?.question || 'question';
  })();

  // Parse `"question"="answer"` pairs from formatAnswersForLLM output.
  const parsedAnswers = (() => {
    if (!tool.result) return [];
    const re = /"(.+?)"="((?:[^"\\]|\\.)*)"/g;
    const out: Array<{ q: string; a: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(tool.result)) !== null) {
      out.push({ q: m[1], a: m[2] });
    }
    return out;
  })();

  const hasResult = tool.result !== undefined;
  const verbKey =
    status === 'running' ? 'streaming.toolAction.running.ask'
    : status === 'error' ? 'streaming.toolAction.error.ask'
    : 'streaming.toolAction.done.ask';

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
        buttonClassName={hasResult ? 'hover:bg-muted/30 cursor-pointer' : 'cursor-default'}
      >
        {summary}
      </ActionRowChrome>

      <AnimatePresence initial={false}>
        {expanded && hasResult && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div className="mx-1 my-1 rounded-lg tool-card p-3 relative">
              {/* Tool label — same chrome as BashToolRow's "Shell"/"Bash" tag */}
              <div className="text-[11px] tool-card-muted font-medium mb-1.5">
                AskUserQuestion
              </div>

              {/* Answer pairs */}
              {parsedAnswers.length > 0 ? (
                <div className="space-y-1">
                  {parsedAnswers.map((pair, i) => (
                    <div key={i} className="font-mono text-[12px] tool-card-subtle leading-relaxed">
                      <span className="tool-card-muted mr-1.5 select-none">›</span>
                      <span className="break-words">{pair.q}</span>
                      <span className="tool-card-faint mx-1.5">→</span>
                      <span className="text-emerald-400 break-words">{pair.a}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="font-mono text-[12px] tool-card-subtle whitespace-pre-wrap break-all max-h-[150px] overflow-auto leading-relaxed">
                  {tool.result}
                </div>
              )}

              {/* Status badge - bottom right, matching BashToolRow */}
              <div className="mt-2 flex justify-end">
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
