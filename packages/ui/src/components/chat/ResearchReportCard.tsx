// ResearchReportCard — standalone card that renders the final deep-research
// report at the end of an assistant reply (plan 423). It replaces the final
// output text: the `research_report` tool action itself renders as a plain,
// non-expandable status row; this card is where the actual report appears.
//
//   - Default: the markdown body is capped to ~half the viewport height.
//   - Expand: a header button toggles the body to its full natural height so
//     the user can scroll the message list to read the whole report.
//   - Header row: report title + Copy / Export (.md) actions on the same line.
//
// The md + title come from the `research_report` tool call input
// (`report_markdown` / `title`), falling back to the tool result envelope
// for older payloads.

'use client';

import React, { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  CopyIcon,
  CheckIcon,
  DownloadSimpleIcon,
  CornersOutIcon,
} from '@/components/icons';
import { MarkdownRenderer } from './MarkdownRenderer';

export interface ResearchReportData {
  title: string;
  markdown: string;
}

/** Extract the report data from a `research_report` ToolAction's input,
 *  falling back to the result envelope for older payloads. */
export function extractResearchReport(input: unknown, result?: string): ResearchReportData | null {
  const inp = (input as Record<string, unknown> | undefined) ?? {};

  let title = typeof inp.title === 'string' ? inp.title.trim() : '';
  let markdown = typeof inp.report_markdown === 'string' ? inp.report_markdown : '';

  // Fallback: read from the result envelope when the input didn't carry it.
  if (!markdown && result) {
    try {
      const parsed = JSON.parse(result) as { title?: unknown; report_markdown?: unknown };
      if (typeof parsed.report_markdown === 'string') markdown = parsed.report_markdown;
      if (typeof parsed.title === 'string' && !title) title = parsed.title.trim();
    } catch {
      /* not JSON — fall through */
    }
  }

  if (!markdown) return null;
  return { title: title || 'Research report', markdown };
}

interface ResearchReportCardProps {
  data: ResearchReportData;
}

export function ResearchReportCard({ data }: ResearchReportCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const markdown = useMemo(() => data.markdown, [data.markdown]);

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore clipboard failures */
    }
  };

  const exportFile = () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `research-report-${stamp}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="rounded-lg border border-border/60 overflow-hidden bg-[var(--surface-solid)]">
      {/* Header row: title + copy / export on the same line. */}
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="font-medium text-sm truncate flex-1">{data.title}</span>

        <button
          type="button"
          onClick={copyToClipboard}
          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-md border border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors shrink-0"
          title="Copy report"
        >
          {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>

        <button
          type="button"
          onClick={exportFile}
          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-md border border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors shrink-0"
          title="Export as markdown"
        >
          <DownloadSimpleIcon size={12} />
          <span>Export</span>
        </button>

        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="inline-flex items-center justify-center p-1.5 rounded-md border border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors shrink-0"
          title={expanded ? 'Collapse report' : 'Expand report'}
          aria-label={expanded ? 'Collapse report' : 'Expand report'}
          aria-expanded={expanded}
        >
          <CornersOutIcon
            size={14}
            className={`transition-transform duration-200 ${expanded ? 'rotate-45' : ''}`}
          />
        </button>
      </div>

      {/* Report body — capped at ~half viewport by default; full height when
          expanded so the message list scrolls to reveal the whole report. */}
      <AnimatePresence initial={false}>
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeInOut' }}
          style={{ overflow: 'hidden' }}
        >
          <div
            className="px-3 py-2 overflow-auto tool-card border-0"
            style={{ maxHeight: expanded ? 'none' : '50vh' }}
          >
            <MarkdownRenderer className="prose prose-sm dark:prose-invert max-w-none tool-card-text">
              {markdown}
            </MarkdownRenderer>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}