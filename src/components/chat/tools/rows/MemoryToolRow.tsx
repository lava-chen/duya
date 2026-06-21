// MemoryToolRow — handles the `Memory` tool (see
// packages/agent/src/memory/tool.ts). The tool returns a JSON envelope:
//   { success, entries?, usage?, error?, message? }
//
// Collapsed:  [verb] [human-readable summary] [StatusDot]
// Expanded:   dark card with action-specific body
//   - list:    entries table (type tag · summary · timestamp · content)
//   - add:     saved summary + content
//   - replace: oldText (strikethrough) + new summary / content
//   - remove:  removed oldText
//   - error:   red-tinted error message
// Status badge in the card footer mirrors BashToolRow / AskUserQuestionResultRow.

'use client';

import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  CheckCircleIcon,
  SpinnerGapIcon,
  XCircleIcon,
} from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import { ActionRowChrome } from '../chrome/ActionRowChrome';
import { getStatus } from '../registry';
import type { ToolAction, ToolStatus } from '../types';
import type { TranslationKey } from '@/i18n';

interface MemoryToolRowProps {
  tool: ToolAction;
}

const MEMORY_TYPE_TONE: Record<string, string> = {
  user: 'text-sky-400 bg-sky-400/10',
  feedback: 'text-amber-400 bg-amber-400/10',
  project: 'text-violet-400 bg-violet-400/10',
  reference: 'text-emerald-400 bg-emerald-400/10',
};

const MEMORY_VERB_BY_ACTION: Record<string, TranslationKey> = {
  list: 'streaming.toolAction.label.memoryList',
  add: 'streaming.toolAction.label.memoryAdd',
  replace: 'streaming.toolAction.label.memoryReplace',
  remove: 'streaming.toolAction.label.memoryRemove',
};

function formatMemorySummary(input: Record<string, unknown>): string {
  const action = typeof input.action === 'string' ? input.action : '';
  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  switch (action) {
    case 'list':
      return 'memory'; // count placeholder — overwritten when result arrives
    case 'add':
      return summary ? `Saved "${summary.length > 50 ? summary.slice(0, 47) + '…' : summary}"` : 'Saved memory';
    case 'replace':
      return summary ? `Updated "${summary.length > 50 ? summary.slice(0, 47) + '…' : summary}"` : 'Updated memory';
    case 'remove':
      return 'Removed memory';
    default:
      return action || 'memory';
  }
}

interface MemoryEntry {
  id?: string;
  summary?: string;
  content?: string;
  timestamp?: string;
  type?: string;
}

function parseMemoryResult(result: string | undefined): {
  ok: boolean;
  entries?: MemoryEntry[];
  usage?: string;
  error?: string;
  message?: string;
} {
  if (!result) return { ok: true };
  try {
    const data = JSON.parse(result);
    if (data && typeof data === 'object') {
      return {
        ok: data.success !== false,
        entries: Array.isArray(data.entries) ? data.entries : undefined,
        usage: typeof data.usage === 'string' ? data.usage : undefined,
        error: typeof data.error === 'string' ? data.error : undefined,
        message: typeof data.message === 'string' ? data.message : undefined,
      };
    }
  } catch {
    // not JSON — fall through
  }
  return { ok: true };
}

function MemoryEntryLine({ entry }: { entry: MemoryEntry }) {
  const tone = entry.type ? MEMORY_TYPE_TONE[entry.type] : undefined;
  const content = typeof entry.content === 'string' ? entry.content.trim() : '';
  return (
    <div className="border-l-2 border-border/40 pl-2.5 py-1">
      <div className="flex items-center gap-1.5 flex-wrap">
        {entry.type && tone && (
          <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${tone}`}>
            {entry.type}
          </span>
        )}
        <span className="text-[12px] tool-card-text break-words flex-1 min-w-0">
          {entry.summary || '(no summary)'}
        </span>
        {entry.timestamp && (
          <span className="text-[10px] tool-card-faint font-mono tabular-nums shrink-0">
            § {entry.timestamp}
          </span>
        )}
      </div>
      {content && (
        <div className="text-[11px] tool-card-muted mt-1 whitespace-pre-wrap break-words leading-relaxed">
          {content.length > 240 ? content.slice(0, 237) + '…' : content}
        </div>
      )}
    </div>
  );
}

export function MemoryToolRow({ tool }: MemoryToolRowProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const status = getStatus(tool);
  const hasResult = tool.result !== undefined && tool.result !== '';
  const inp = (tool.input || {}) as Record<string, unknown>;
  const action = typeof inp.action === 'string' ? inp.action : '';
  const target = typeof inp.target === 'string' ? inp.target : 'global';
  const subtarget = typeof inp.subtarget === 'string' ? inp.subtarget : 'memory';

  const parsed = hasResult ? parseMemoryResult(tool.result) : null;
  const entryCount = parsed?.entries?.length ?? 0;
  const isError = status === 'error' || (parsed?.ok === false);

  // Collapsed summary: prefer the live entry count for `list` so the user
  // sees "Read 3 memories" as soon as the result arrives.
  const summary = (() => {
    if (action === 'list' && parsed?.entries) {
      return entryCount === 1 ? '1 memory' : `${entryCount} memories`;
    }
    return formatMemorySummary(inp);
  })();

  const verbKey = MEMORY_VERB_BY_ACTION[action];
  const verb = verbKey ? t(verbKey) : t('streaming.toolAction.label.memory');

  // Sub-label inside the card header (e.g. "global · memory").
  const subLabel = target === 'project' ? 'project' : `global · ${subtarget}`;

  // The chrome picks its own status dot, so we override the status
  // field when the parsed result implies an error that `isError`
  // missed (matches the prior ad-hoc `isError ? 'error' : status`
  // pattern that used to live at the bottom of the button).
  const rowStatus: ToolStatus = isError ? 'error' : status;
  // Running state verb has a dedicated key. Once finished, fall back
  // to the action-specific verb (Saved / Read / Updated / Removed).
  const chromeVerbKey =
    rowStatus === 'running'
      ? 'streaming.toolAction.running.memory'
      : rowStatus === 'error'
        ? 'streaming.toolAction.error.memory'
        : verbKey;

  return (
    <div>
      <ActionRowChrome
        status={rowStatus}
        verbKey={chromeVerbKey}
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
              {/* Card header — same chrome as BashToolRow's "Shell" tag */}
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-[11px] tool-card-muted font-medium">Memory</span>
                <span className="text-[10px] tool-card-faint font-mono">{subLabel}</span>
              </div>

              {/* Body — dispatched by action */}
              {isError && parsed?.error ? (
                <div className="bg-red-500/10 rounded p-2 font-mono text-[11px] text-red-400 whitespace-pre-wrap max-h-[200px] overflow-auto">
                  {parsed.error}
                </div>
              ) : action === 'list' ? (
                <>
                  {parsed?.usage && (
                    <div className="text-[10px] tool-card-faint font-mono mb-1.5">
                      {parsed.usage}
                    </div>
                  )}
                  {entryCount === 0 ? (
                    <div className="text-[12px] tool-card-faint italic">No memories</div>
                  ) : (
                    <div className="space-y-1 max-h-[260px] overflow-auto pr-1">
                      {(parsed?.entries ?? []).map((entry, i) => (
                        <MemoryEntryLine key={entry.id ?? `entry-${i}`} entry={entry} />
                      ))}
                    </div>
                  )}
                </>
              ) : action === 'add' || action === 'replace' ? (
                <div className="space-y-1.5">
                  {typeof inp.oldText === 'string' && inp.oldText && (
                    <div className="text-[11px] tool-card-faint leading-relaxed">
                      <span className="tool-card-faint mr-1.5 select-none">−</span>
                      <span className="line-through break-words">{inp.oldText}</span>
                    </div>
                  )}
                  <div className="text-[12px] tool-card-text leading-relaxed">
                    <span className="text-emerald-500 mr-1.5 select-none">+</span>
                    <span className="break-words">
                      {typeof inp.summary === 'string' && inp.summary ? inp.summary : '(no summary)'}
                    </span>
                  </div>
                  {typeof inp.content === 'string' && inp.content && (
                    <div className="text-[11px] tool-card-muted mt-1 whitespace-pre-wrap break-words leading-relaxed border-l-2 border-emerald-500/30 pl-2">
                      {inp.content}
                    </div>
                  )}
                  {parsed?.message && (
                    <div className="text-[10px] tool-card-faint mt-1">{parsed.message}</div>
                  )}
                </div>
              ) : action === 'remove' ? (
                <div className="space-y-1.5">
                  {typeof inp.oldText === 'string' && inp.oldText && (
                    <div className="text-[11px] tool-card-muted leading-relaxed">
                      <span className="text-red-400 mr-1.5 select-none">−</span>
                      <span className="line-through break-words">{inp.oldText}</span>
                    </div>
                  )}
                  {parsed?.message && (
                    <div className="text-[10px] tool-card-faint">{parsed.message}</div>
                  )}
                </div>
              ) : (
                <div className="font-mono text-[11px] tool-card-muted whitespace-pre-wrap break-all max-h-[200px] overflow-auto">
                  {tool.result}
                </div>
              )}

              {/* Status badge — bottom right, matching BashToolRow */}
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
