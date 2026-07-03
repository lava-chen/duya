// ModuleToolRow — handles the `read_module` tool (see
// packages/agent/src/tool/ModuleTool/ModuleTool.ts). The tool returns
// the inlined design specification README for one or more modules
// joined with `\n\n---\n\n`. The body is markdown (headings, tables,
// code blocks), so we render it with MarkdownRenderer — same pattern
// as SkillToolRow. There's no base-directory prefix to strip, so the
// row is simpler than SkillToolRow.
//
// Collapsed:  [verb] [module list]            [icon]
// Expanded:   dark card with the joined markdown rendered via
//             MarkdownRenderer. Markdown parsing only happens once the
//             user expands the row — DOM is unmounted while collapsed
//             so the heavy remark/katex pipelines don't run on hidden
//             rows.
//
// `input.module` may be a string (one module) or string[] (multiple).
// We render the list as `a + b + c` in the summary so users see at a
// glance which design specs were loaded.

'use client';

import React, { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  CheckCircleIcon,
  SpinnerGapIcon,
  XCircleIcon,
} from '@/components/icons';
import { ActionRowChrome } from '../chrome/ActionRowChrome';
import { getStatus } from '../registry';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import type { ToolAction, ToolStatus } from '../types';

interface ModuleToolRowProps {
  tool: ToolAction;
}

/** Extract the module names from `input.module` (string or string[]). */
function parseModuleNames(input: unknown): string[] {
  const mod = (input as Record<string, unknown> | undefined)?.module;
  if (typeof mod === 'string' && mod.length > 0) return [mod];
  if (Array.isArray(mod)) {
    return mod.filter((s): s is string => typeof s === 'string' && s.length > 0);
  }
  return [];
}

export function ModuleToolRow({ tool }: ModuleToolRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const status = getStatus(tool);
  const hasResult = tool.result !== undefined && tool.result !== '';

  // Stable references for the same tool.input / tool.result so the
  // expensive MarkdownRenderer doesn't re-parse on parent re-renders.
  const moduleNames = useMemo(() => parseModuleNames(tool.input), [tool.input]);
  const markdown = useMemo(() => tool.result ?? '', [tool.result]);

  // Header summary: list the loaded modules. Falls back to a generic
  // `module` placeholder when the input shape is unknown (older /
  // non-standard payloads).
  const summary = moduleNames.length > 0 ? moduleNames.join(' + ') : 'module';

  const verbKey =
    status === 'running' ? 'streaming.toolAction.running.module'
    : status === 'error' ? 'streaming.toolAction.error.module'
    : 'streaming.toolAction.done.module';

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
      >
        {summary}
      </ActionRowChrome>

      <AnimatePresence initial={false}>
        {expanded && hasResult && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div className="mx-1 my-1 rounded-lg tool-card p-3 relative">
              {/* Markdown body — only mounted while the row is expanded.
               * Collapsing unmounts the subtree, so react-markdown's
               * pipeline (remark-gfm + remark-math + rehype-katex) is
               * not paid for hidden rows. We size down to ~11px base
               * (smaller than `prose-xs`'s 12px) and cap height to
               * `60vh` because a single module README can run several
               * hundred lines. Typography plugin knobs are scaled in
               * globals.css to keep headings proportional. */}
              <div className="max-h-[60vh] overflow-auto pr-1">
                <MarkdownRenderer className="prose prose-sm dark:prose-invert max-w-none tool-card-text">
                  {markdown}
                </MarkdownRenderer>
              </div>

              {/* Status badge — bottom right, matching BashToolRow */}
              <div className="mt-2 flex justify-end">
                <ModuleStatusBadge status={status} />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ModuleStatusBadge({ status }: { status: ToolStatus }) {
  if (status === 'success') {
    return (
      <div className="flex items-center gap-1 text-[11px] text-green-500">
        <CheckCircleIcon size={12} />
        <span>Success</span>
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="flex items-center gap-1 text-[11px] text-red-500">
        <XCircleIcon size={12} />
        <span>Failed</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1 text-[11px] text-amber-500">
      <SpinnerGapIcon size={12} className="animate-spin" />
      <span>Running</span>
    </div>
  );
}