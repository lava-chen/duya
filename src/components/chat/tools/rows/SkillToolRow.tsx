// SkillToolRow — handles the `Skill` tool (see
// packages/agent/src/tool/SkillTool/SkillTool.ts). The tool returns a
// JSON envelope:
//   { success, commandName, status, allowedTools?, model?, content }
//
// `content` is the actual skill markdown body, optionally prefixed with
// `Base directory for this skill: <path>\n\n` so the model can locate
// the skill's source on disk. We split the prefix off and surface the
// path in the header's right slot (same place ReadToolRow puts its
// `L12-45` range) so the markdown body stays clean.
//
// Collapsed:  [verb] [skill name]            [baseDir mono]
// Expanded:   dark card with the parsed markdown rendered via
//             MarkdownRenderer. Markdown parsing only happens once the
//             user expands the row — the row is the most common case
//             where react-markdown would be paid for work the user
//             never reads, so we keep it inside the `expanded &&`
//             branch (DOM is unmounted while collapsed).

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

interface SkillToolRowProps {
  tool: ToolAction;
}

const BASE_DIR_RE = /^Base directory for this skill:\s*(.+?)\s*\n\n?/;

interface ParsedSkillResult {
  /** Path extracted from the `Base directory for this skill:` prefix, or
   *  null when the prefix is absent (e.g. older result formats). */
  baseDir: string | null;
  /** The markdown body, with the base-directory prefix stripped. */
  markdown: string;
  /** Friendly command name from the JSON envelope (usually equals the
   *  skill name from `tool.input.skill`). Falls back to `'skill'`. */
  commandName: string;
}

/**
 * Parse the SkillTool's JSON envelope. Returns null when the result is
 * missing or unparseable — the caller then falls back to rendering the
 * raw text. Memoization lives at the call site so a re-render with the
 * same `tool.result` reference doesn't re-parse.
 */
function parseSkillResult(result: string | undefined): ParsedSkillResult | null {
  if (!result) return null;
  // Fast path: the body might be a plain skill markdown that was never
  // wrapped in a JSON envelope (e.g. raw tool output from earlier code
  // paths). Treat the whole thing as markdown in that case.
  let content: string;
  let commandName = 'skill';
  const trimmed = result.trim();
  if (trimmed.startsWith('{')) {
    try {
      const data = JSON.parse(trimmed) as Record<string, unknown>;
      const rawContent = data.content;
      if (typeof rawContent !== 'string' || !rawContent) return null;
      content = rawContent;
      if (typeof data.commandName === 'string' && data.commandName.trim()) {
        commandName = data.commandName.trim();
      }
    } catch {
      return null;
    }
  } else {
    content = result;
  }

  const match = content.match(BASE_DIR_RE);
  const baseDir = match ? match[1].trim() : null;
  const markdown = match ? content.slice(match[0].length) : content;
  return { baseDir, markdown, commandName };
}

export function SkillToolRow({ tool }: SkillToolRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const status = getStatus(tool);
  const hasResult = tool.result !== undefined && tool.result !== '';

  // Parse once per `tool.result` change. The parse is cheap (a single
  // JSON.parse + a small regex) but the downstream MarkdownRenderer
  // re-runs its full pipeline on any new string, so we hand it a
  // stable reference for the same content.
  const parsed = useMemo(
    () => parseSkillResult(tool.result),
    [tool.result],
  );

  // Header summary: prefer the JSON envelope's commandName, fall back
  // to the input's `skill` field, then a generic 'skill' placeholder.
  const summary = useMemo(() => {
    if (parsed?.commandName && parsed.commandName !== 'skill') return parsed.commandName;
    const inp = (tool.input || {}) as Record<string, unknown>;
    const fromInput = typeof inp.skill === 'string' ? inp.skill.trim() : '';
    return fromInput || 'skill';
  }, [parsed, tool.input]);

  const baseDir = parsed?.baseDir ?? null;
  const markdown = parsed?.markdown ?? '';

  const verbKey =
    status === 'running' ? 'streaming.toolAction.running.skill'
    : status === 'error' ? 'streaming.toolAction.error.skill'
    : 'streaming.toolAction.done.skill';

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
          baseDir ? (
            <span
              className="text-muted-foreground/40 text-[11px] font-mono truncate max-w-[260px] hidden sm:inline"
              title={baseDir}
            >
              {baseDir}
            </span>
          ) : null
        }
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
            <div className="mx-0.5 my-0.5 rounded-lg tool-card p-2.5 relative">
              {/* Markdown body — only mounted while the row is expanded.
               * Collapsing unmounts the subtree, so react-markdown's
               * pipeline (remark-gfm + remark-math + rehype-katex) is
               * not paid for hidden rows. We size down to ~11px base
               * (smaller than `prose-xs`'s 12px) and cap height to
               * `35vh` because a skill body can run hundreds of lines
               * — without shrinking it dominates the chat scroll and
               * pushes the next message out of view. Typography plugin
               * knobs (h1/h2/h3, li margins) are scaled in globals.css
               * under the `.tool-skill-card` selector so headings stay
               * proportional instead of the typography default 1.5x
               * jump that `prose` applies on its own. */}
              {parsed ? (
                <div className="max-h-[35vh] overflow-auto pr-1 tool-skill-card">
                  <MarkdownRenderer className="prose dark:prose-invert max-w-none tool-card-text">
                    {markdown}
                  </MarkdownRenderer>
                </div>
              ) : (
                <div className="font-mono text-[11px] tool-card-muted whitespace-pre-wrap break-all max-h-[200px] overflow-auto">
                  {tool.result}
                </div>
              )}

              {/* Status badge — same pattern as the other tool rows */}
              <div className="mt-1.5 flex justify-end">
                <SkillStatusBadge status={status} />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SkillStatusBadge({ status }: { status: ToolStatus }) {
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
