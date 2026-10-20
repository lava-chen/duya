// BrowserToolRow — renders browser tool actions (search, parallel_fetch,
// navigate, etc.).
//
// - search / parallel_fetch: magnifier header (query + engine on one line)
//   + expandable card that renders the raw tool-result markdown inside
//   (no result-count guessing — the markdown is the source of truth).
// - Single-page fetch (navigate / go_back): renders the fetched page
//   directly (favicon + title + link on a single line) with no header.

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
  ChromeIcon,
} from '@/components/icons';
import { useLinkFavicon } from '@/lib/link-favicon';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
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

// Human-readable (Chinese) description per browser operation, rendered in the
// plain one-line status row. Falls back to the raw operation name for
// operations not listed here.
const BROWSER_OPERATION_LABELS: Record<string, string> = {
  navigate: '已打开页面',
  go_back: '已返回上一页',
  snapshot: '已获取页面结构',
  screenshot: '已截图',
  click: '已点击',
  type: '已输入文本',
  scroll: '已下滑页面',
  press_key: '已按键',
  hover: '已悬停',
  select: '已选择',
  wait: '已等待',
  evaluate: '已执行脚本',
  tabs_list: '已列出标签页',
  tabs_new: '已新建标签页',
  tabs_close: '已关闭标签页',
  tabs_select: '已切换标签页',
  file_upload: '已上传文件',
  post: '已发布动态',
  network_start: '已监听网络',
  network_read: '已读取网络请求',
  iframe_evaluate: '已在页面内执行',
  cookies: '已读取 Cookie',
  vision_analyze: '已分析截图',
};

export function describeBrowserOperation(operation: string): string {
  return BROWSER_OPERATION_LABELS[operation] || operation;
}

function extractQueryText(input: unknown): string | undefined {
  const inp = (input || {}) as Record<string, unknown>;
  if (typeof inp.task === 'string' && inp.task.trim()) return inp.task.trim();
  if (typeof inp.query === 'string' && inp.query.trim()) return inp.query.trim();
  if (typeof inp.q === 'string' && inp.q.trim()) return inp.q.trim();
  return undefined;
}

const ENGINE_LABELS: Record<string, string> = {
  google: 'Google',
  bing: 'Bing',
  baidu: '百度',
  duckduckgo: 'DuckDuckGo',
  brave: 'Brave',
  yahoo: 'Yahoo',
};

/**
 * Resolve the search engine shown in the row: the `engineUsed` reported in
 * the result markdown wins (it is the authoritative engine that actually
 * served the SERP), otherwise the `engine` requested in the tool input.
 * `auto` / `unknown` resolve to nothing so the row shows no engine badge.
 */
export function extractEngineText(tool: ToolAction): string | undefined {
  const input = (tool.input ?? {}) as Record<string, unknown>;
  const requested = typeof input.engine === 'string' ? input.engine : '';
  const used = tool.result?.match(/- Engine:\s*([^\s(]+)/)?.[1];
  const engine = (used || requested || '').trim().toLowerCase();
  if (!engine || engine === 'auto' || engine === 'unknown') return undefined;
  return ENGINE_LABELS[engine] ?? engine;
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

export function extractBrowserResults(tool: ToolAction): BrowserResultItem[] {
  // Prefer structured metadata produced by BrowserTool.execute and
  // forwarded through the SSE tool_result event.
  const metadata = (tool.metadata ?? {}) as { browserResults?: BrowserResultItem[] };
  if (Array.isArray(metadata.browserResults) && metadata.browserResults.length > 0) {
    return metadata.browserResults.filter((r): r is BrowserResultItem => typeof r.url === 'string');
  }

  const result = tool.result;
  if (!result) return [];

  // Some browser paths deliver a JSON envelope (e.g. `{ results: [...] }`).
  const trimmed = result.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { results?: unknown };
      if (Array.isArray(parsed.results)) {
        return parsed.results.filter(
          (r): r is BrowserResultItem =>
            !!r && typeof r === 'object' && typeof (r as BrowserResultItem).url === 'string',
        );
      }
    } catch {
      // Not JSON — fall through to markdown parsing.
    }
  }

  if (result.includes('### Parallel Fetch Results')) {
    return parseParallelFetchMarkdown(result);
  }

  if (result.includes('### Page')) {
    return parseSinglePageMarkdown(result);
  }

  return [];
}

/**
 * Strip the model-facing envelope (`[completed] browser\n…\n[Duration: Nms]`)
 * from a tool result so the expandable card shows only the real content.
 */
function stripToolEnvelope(result: string | undefined): string {
  if (!result) return '';
  return result
    .replace(/^\[completed\]\s+\S+\s*\n/, '')
    .replace(/\n\[Duration:\s*\d+ms\]\s*$/, '')
    .trim();
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

// Single one-line link row used for navigate / go_back page links. The link
// icon is replaced by the site favicon once it resolves (and only then —
// resolution failures keep the placeholder icon).
function ResultLink({ item }: { item: BrowserResultItem }) {
  const favicon = useLinkFavicon(item.url);
  const [imgFailed, setImgFailed] = useState(false);
  const showFavicon = !!favicon && !imgFailed;

  return (
    <a
      href={item.url}
      target="_blank"
      rel="noreferrer"
      title={item.error || item.url}
      onClick={(e) => {
        e.preventDefault();
        window.open(item.url, '_blank', 'noopener,noreferrer');
      }}
      className="group flex w-full items-center gap-2 min-w-0 text-sm rounded-sm hover:bg-muted/30 transition-colors"
    >
      {showFavicon ? (
        <img
          src={favicon}
          alt=""
          loading="lazy"
          onError={() => setImgFailed(true)}
          className="shrink-0 size-3.5 rounded-[3px] object-contain"
        />
      ) : (
        <LinkSimpleIcon
          size={13}
          className="shrink-0 text-muted-foreground/50 group-hover:text-muted-foreground/70 transition-colors"
        />
      )}
      <span className="truncate text-foreground/90 underline underline-offset-2 decoration-border group-hover:text-foreground">
        {item.title || item.url}
      </span>
      <span className="text-[11px] text-muted-foreground/50 truncate shrink-0">
        {extractDomain(item.url)}
      </span>
    </a>
  );
}

export function BrowserToolRow({ tool }: BrowserToolRowProps) {
  const status = getStatus(tool);
  const [expanded, setExpanded] = useState(false);

  const items = useMemo(() => extractBrowserResults(tool), [tool]);
  const query = useMemo(() => extractQueryText(tool.input), [tool.input]);
  const engine = useMemo(() => extractEngineText(tool), [tool]);
  // `displayResult` must be computed before any early returns so the hook
  // count stays stable across operation types (navigate vs. search vs.
  // click/...). Earlier returns below intentionally short-circuit before
  // `displayResult` is read, but the memo still runs.
  const displayResult = useMemo(() => stripToolEnvelope(tool.result), [tool.result]);
  const isRunning = status === 'running';
  const hasItems = items.length > 0;
  const input = (tool.input ?? {}) as Record<string, unknown>;
  const operation = typeof input.operation === 'string' ? input.operation : '';
  const isParallel = operation === 'parallel_fetch';
  const isSearch = operation === 'search';
  const isSearchCard = isParallel || isSearch;
  const isPageOp = operation === 'navigate' || operation === 'go_back';
  const canExpand = isSearchCard && !!tool.result && !isRunning;

  // Single-page fetch: render the page directly, no "搜索「query」" header.
  if (isPageOp && hasItems) {
    return (
      <div className="px-2 py-0.5">
        <ResultLink item={items[0]} />
      </div>
    );
  }

  // Other browser actions (click/type/screenshot/tabs/…): a plain one-line
  // status row. Only parallel_fetch / search read as a search — nothing
  // else should.
  if (!isSearchCard) {
    return (
      <div className="flex items-center gap-2 px-2 py-1 min-h-6 text-sm">
        <ChromeIcon size={14} className="shrink-0 text-muted-foreground/60" />
        <span className="text-foreground/90 flex-1 min-w-0 truncate text-left">
          {describeBrowserOperation(operation)}
        </span>
        {tool.durationMs != null && tool.durationMs > 0 && !isRunning && (
          <span className="text-muted-foreground/50 text-[11px] tabular-nums shrink-0 font-mono">
            {formatDuration(tool.durationMs)}
          </span>
        )}
        <StatusIcon status={status} />
      </div>
    );
  }

  const headerLabel = query ? `搜索「${query}」` : isParallel ? '并行抓取网页' : '搜索';
  const cardLabel = isParallel ? '并行抓取结果' : '搜索结果';

  return (
    <div>
      <button
        type="button"
        disabled={!canExpand}
        onClick={() => canExpand && setExpanded((prev) => !prev)}
        className={
          'group flex w-full items-center gap-2 px-2 py-1 min-h-6 text-sm rounded-sm transition-colors ' +
          (canExpand ? 'cursor-pointer hover:bg-muted/30' : 'cursor-default')
        }
      >
        <MagnifyingGlassIcon
          size={14}
          className="shrink-0 text-muted-foreground/60 group-hover:text-muted-foreground/80 transition-colors"
        />
        <span className="flex items-center gap-1.5 flex-1 min-w-0 text-left">
          <span className="truncate text-foreground/90">{headerLabel}</span>
          {engine && (
            <span className="whitespace-nowrap shrink-0 rounded-sm bg-muted/60 px-1 py-px text-[10px] leading-4 text-muted-foreground/80">
              {engine}
            </span>
          )}
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
            <div className="mx-1 my-1 rounded-lg tool-card p-3 relative">
              {/* Card label — same chrome as the bash tool card */}
              <div className="text-[11px] tool-card-muted font-medium mb-1.5">
                {cardLabel}
                {engine ? ` · ${engine}` : ''}
              </div>
              {/* Raw tool-result markdown */}
              <div className="text-[13px] leading-relaxed max-h-[300px] overflow-auto pr-1">
                <MarkdownRenderer className="prose prose-sm dark:prose-invert max-w-none">
                  {displayResult}
                </MarkdownRenderer>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
