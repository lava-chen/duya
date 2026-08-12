// BrowserToolRow — renders browser tool actions (parallel_fetch, navigate,
// etc.) as a search-result card.
//
// Collapsed: magnifier icon + "搜索「query」" (or "并行抓取网页") + chevron + duration.
// Expanded:  a vertical rule with link rows (icon, title, domain).

'use client';

import React, { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  MagnifyingGlassIcon,
  LinkSimpleIcon,
  ChevronDownIcon,
  SpinnerGapIcon,
  CheckCircleIcon,
  XCircleIcon,
} from '@/components/icons';
import { getStatus } from '../registry';
import type { ToolAction, ToolStatus } from '../types';

interface BrowserToolRowProps {
  tool: ToolAction;
}

interface BrowserResultItem {
  url: string;
  title?: string;
  success?: boolean;
  error?: string;
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return '';
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds.toFixed(0)}s`;
  }
  return `${seconds.toFixed(1)}s`;
}

function extractDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function extractQueryText(input: unknown): string | undefined {
  const inp = (input || {}) as Record<string, unknown>;
  if (typeof inp.task === 'string' && inp.task.trim()) return inp.task.trim();
  if (typeof inp.query === 'string' && inp.query.trim()) return inp.query.trim();
  if (typeof inp.q === 'string' && inp.q.trim()) return inp.q.trim();
  return undefined;
}

function parseParallelFetchMarkdown(result: string): BrowserResultItem[] {
  const items: BrowserResultItem[] = [];
  const headerRe = /^####\s*\[[^\]]*\]\s*(.+)$/gm;
  const titleRe = /\*\*Title\*\*:\s*([^|\n]+)/;

  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(result)) !== null) {
    const url = match[1].trim();
    const titleMatch = result.slice(match.index).match(titleRe);
    items.push({
      url,
      title: titleMatch ? titleMatch[1].trim() : undefined,
    });
  }
  return items;
}

function parseSinglePageMarkdown(result: string): BrowserResultItem[] {
  const urlMatch = result.match(/[-*]\s*URL:\s*(.+)$/m);
  const titleMatch = result.match(/[-*]\s*Title:\s*(.+)$/m);
  if (!urlMatch) return [];
  return [
    {
      url: urlMatch[1].trim(),
      title: titleMatch ? titleMatch[1].trim() : undefined,
    },
  ];
}

function extractBrowserResults(tool: ToolAction): BrowserResultItem[] {
  // Prefer structured metadata produced by BrowserTool.execute.
  const metadata = (tool.metadata ?? {}) as { browserResults?: BrowserResultItem[] };
  if (Array.isArray(metadata.browserResults) && metadata.browserResults.length > 0) {
    return metadata.browserResults.filter((r): r is BrowserResultItem => typeof r.url === 'string');
  }

  const result = tool.result;
  if (!result) return [];

  if (result.includes('### Parallel Fetch Results')) {
    return parseParallelFetchMarkdown(result);
  }

  if (result.includes('### Page')) {
    return parseSinglePageMarkdown(result);
  }

  return [];
}

function StatusIcon({ status }: { status: ToolStatus }) {
  if (status === 'running') {
    return <SpinnerGapIcon size={14} className="shrink-0 animate-spin text-muted-foreground/50" />;
  }
  if (status === 'error') {
    return <XCircleIcon size={14} className="shrink-0 text-red-500" />;
  }
  return <CheckCircleIcon size={14} className="shrink-0 text-green-500" />;
}

export function BrowserToolRow({ tool }: BrowserToolRowProps) {
  const status = getStatus(tool);
  const [expanded, setExpanded] = useState(false);

  const items = useMemo(() => extractBrowserResults(tool), [tool]);
  const query = useMemo(() => extractQueryText(tool.input), [tool.input]);
  const isRunning = status === 'running';
  const hasItems = items.length > 0;
  const canExpand = hasItems && !isRunning;

  const successfulCount = useMemo(
    () => items.filter((i) => i.success !== false && !i.error).length,
    [items],
  );

  const headerLabel = query ? `搜索「${query}」` : '并行抓取网页';
  const subLabel = isRunning
    ? '…'
    : query
      ? `${items.length} 个结果`
      : `${successfulCount}/${items.length} 个网页`;

  return (
    <div>
      <button
        type="button"
        disabled={!canExpand}
        onClick={() => canExpand && setExpanded((prev) => !prev)}
        className={
          'group flex w-full items-center gap-2 px-2 py-1 min-h-7 text-sm rounded-sm transition-colors ' +
          (canExpand ? 'cursor-pointer hover:bg-muted/30' : 'cursor-default')
        }
      >
        <MagnifyingGlassIcon
          size={14}
          className="shrink-0 text-muted-foreground/60 group-hover:text-muted-foreground/80 transition-colors"
        />
        <span className="flex items-baseline gap-1.5 flex-1 min-w-0 text-left">
          <span className="text-foreground/90">{headerLabel}</span>
          <span className="text-muted-foreground/60 text-[11px]">{subLabel}</span>
        </span>
        {canExpand && (
          <ChevronDownIcon
            size={14}
            className={`shrink-0 text-muted-foreground/50 transition-transform duration-200 ${
              expanded ? 'rotate-180' : ''
            }`}
          />
        )}
        {tool.durationMs != null && tool.durationMs > 0 && !isRunning && (
          <span className="text-muted-foreground/50 text-[11px] tabular-nums shrink-0 font-mono">
            {formatDuration(tool.durationMs)}
          </span>
        )}
        <StatusIcon status={status} />
      </button>

      <AnimatePresence initial={false}>
        {expanded && canExpand && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div className="ml-2 my-1 space-y-0.5">
              {items.map((item, index) => (
                <div key={`${item.url}-${index}`} className="flex items-start gap-2 py-1">
                  <div className="w-px self-stretch min-h-[20px] bg-border/60 rounded-full shrink-0 mt-0.5" />
                  <div className="flex items-start gap-2 min-w-0 flex-1">
                    <LinkSimpleIcon
                      size={13}
                      className="shrink-0 text-muted-foreground/50 mt-0.5"
                    />
                    <div className="flex flex-col min-w-0 flex-1">
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        title={item.url}
                        className="text-sm text-foreground/90 underline underline-offset-2 decoration-border hover:text-foreground truncate text-left"
                      >
                        {item.title || item.url}
                      </a>
                      <span className="text-[11px] text-muted-foreground/50 truncate">
                        {extractDomain(item.url)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
