import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { markdownComponents } from './markdownComponents';
import { useTranslation } from '@/hooks/useTranslation';

/**
 * Preprocess markdown text to fix bold syntax issues with text containing parentheses.
 *
 * micromark parser (used by react-markdown) doesn't recognize `**...**` bold when
 * the content contains parentheses like `**text (content)**`. This is a known
 * limitation in CommonMark spec handling of emphasis with punctuation.
 *
 * We work around it by inserting zero-width spaces (\u200B) inside the bold markers
 * when parentheses are detected within the bold content.
 */
export function preprocessMarkdownBold(text: string): string {
  // Match **...** patterns (non-greedy, single line)
  // Only fix those containing parentheses (full-width or half-width)
  return text.replace(/\*\*([^\n*]+?)\*\*/g, (match, content) => {
    if (/[（）()]/.test(content)) {
      return `**\u200B${content}\u200B**`;
    }
    return match;
  });
}

// Convert bare image URLs (https://.../*.jpg|png|gif|webp|bmp|svg) that are
// NOT already inside a markdown image/link into `![](url)` so the renderer
// displays them. This lets the assistant drop a plain image link and still
// get an inline thumbnail.
const BARE_IMAGE_URL_RE =
  /(?<![(<!\[]\s*)(https?:\/\/[^\s<>()"']+\.(?:jpg|jpeg|png|gif|webp|bmp|svg)(?:\?[^\s<>()"']*)?)/gi;

export function preprocessBareImageLinks(text: string): string {
  return text.replace(BARE_IMAGE_URL_RE, (match, url, offset, full) => {
    // Skip if this URL is the destination of an existing markdown image/link.
    // Look back a few chars for `](` or `![`.
    const lookback = full.slice(Math.max(0, offset - 3), offset);
    if (lookback.includes('](') || lookback.endsWith('![')) {
      return match;
    }
    return `![](${url})`;
  });
}

interface FrontmatterResult {
  meta: Record<string, string> | null;
  content: string;
}

/**
 * Extract a simple YAML-style frontmatter block (`---\n...\n---\n`) from the
 * start of markdown content. Only flat key: value pairs are parsed; nested
 * structures are kept as raw strings for display.
 */
export function parseFrontmatter(text: string): FrontmatterResult {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(text);
  if (!match) return { meta: null, content: text };

  const raw = match[1];
  const meta: Record<string, string> = {};
  let currentKey: string | null = null;
  let currentValue = '';

  const flush = () => {
    if (currentKey !== null) {
      meta[currentKey] = currentValue.trim();
    }
  };

  for (let line of raw.split('\n')) {
    // Support block scalars (`|` and `>`) by keeping indentation lines as-is.
    if (currentKey !== null && (line.startsWith(' ') || line.startsWith('\t'))) {
      currentValue += '\n' + line.trimEnd();
      continue;
    }
    flush();
    currentKey = null;
    currentValue = '';

    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (!key) continue;

    // Strip matching surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    currentKey = key;
    currentValue = value;
  }
  flush();

  return { meta, content: text.slice(match[0].length) };
}

function FrontmatterCard({ meta }: { meta: Record<string, string> }) {
  const { t } = useTranslation();
  const entries = Object.entries(meta).filter(([, value]) => value !== '');
  if (entries.length === 0) return null;

  return (
    <div className="markdown-frontmatter-card">
      <div className="markdown-frontmatter-card-header">{t('filePreview.frontmatterTitle')}</div>
      <dl className="markdown-frontmatter-card-body">
        {entries.map(([key, value]) => (
          <div key={key} className="markdown-frontmatter-card-row">
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ─── Memory citation extraction & rendering ─────────────────────────────────

export interface MemoryCitationEntry {
  /** Relative file path under the memory base dir, e.g. `MEMORY.md`, `rollout_summaries/xxx.md` */
  file: string;
  /** Line range in the form "start-end" or single line; null if absent. */
  lineRange: string | null;
  /** Optional free-text note explaining how the memory was used. */
  note: string | null;
}

export interface MemoryCitation {
  entries: MemoryCitationEntry[];
  rolloutIds: string[];
}

const MEM_CITATION_RE = /<duya-mem-citation>\s*([\s\S]*?)<\/duya-mem-citation>\s*$/;
const CITATION_ENTRIES_RE = /<citation_entries>\s*([\s\S]*?)\s*<\/citation_entries>/;
const ROLLOUT_IDS_RE = /<rollout_ids>\s*([\s\S]*?)\s*<\/rollout_ids>/;

/**
 * Strip and parse a trailing `<duya-mem-citation>` block from markdown text.
 * The block is emitted by the agent per memorySection.ts and must never
 * surface as raw XML in the UI. Returns `{ cleanedText, citation }` where
 * `citation` is null if no valid, well-formed block was found.
 */
export function extractMemoryCitation(text: string): { cleanedText: string; citation: MemoryCitation | null } {
  const blockMatch = MEM_CITATION_RE.exec(text);
  if (!blockMatch) return { cleanedText: text, citation: null };

  const rawBlock = blockMatch[1];
  const cleanedText = text.slice(0, blockMatch.index).trimEnd();

  const entries: MemoryCitationEntry[] = [];
  const entriesMatch = CITATION_ENTRIES_RE.exec(rawBlock);
  if (entriesMatch) {
    for (const rawLine of entriesMatch[1].split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      // Format: <file>:<line_start>-<line_end>|note=[<note>]
      // note portion is optional, line range portion too in degenerate cases
      const sep = line.indexOf('|');
      const left = sep === -1 ? line : line.slice(0, sep);
      const right = sep === -1 ? null : line.slice(sep + 1);

      let file = left;
      let lineRange: string | null = null;
      // Match last colon followed by digits-digits (line range suffix)
      // We anchor at the end because Windows paths like `C:\foo` have colons too,
      // but memory paths are relative (per the contract), so `:` only appears
      // as the file / line-range separator.
      const lineRangeMatch = /:(\d+(?:-\d+)?)$/.exec(left);
      if (lineRangeMatch) {
        file = left.slice(0, lineRangeMatch.index);
        lineRange = lineRangeMatch[1];
      }

      let note: string | null = null;
      if (right) {
        const noteMatch = /^note=\[([\s\S]*)\]$/.exec(right.trim());
        if (noteMatch) note = noteMatch[1].trim();
      }
      if (!file) continue;
      entries.push({ file, lineRange, note });
    }
  }

  const rolloutIds: string[] = [];
  const rolloutMatch = ROLLOUT_IDS_RE.exec(rawBlock);
  if (rolloutMatch) {
    for (const rawLine of rolloutMatch[1].split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line) rolloutIds.push(line);
    }
  }

  if (entries.length === 0 && rolloutIds.length === 0) {
    return { cleanedText, citation: null };
  }

  return { cleanedText, citation: { entries, rolloutIds } };
}

function MemoryCitationCard() {
  // Rendering was moved to the message action bar (bottom of the assistant
  // bubble) as a hover-triggered popover next to the copy button, matching
  // the reference design. This component is intentionally empty — we still
  // strip the XML block above so ReactMarkdown never sees it, but the
  // citation UI lives in MessageItem instead of inside the prose body.
  return null;
}

interface MarkdownRendererProps {
  children: string;
  className?: string;
  showFrontmatterCard?: boolean;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  children,
  className,
  showFrontmatterCard = false,
}) => {
  // 1) Strip the internal <duya-mem-citation> block before any markdown
  //    processing. The citation data is surfaced to the UI via a separate
  //    hover popover in the message action bar (see MessageItem.tsx).
  const { cleanedText } = extractMemoryCitation(children);

  const processed = preprocessBareImageLinks(preprocessMarkdownBold(cleanedText));
  const { meta, content } = parseFrontmatter(processed);

  return (
    <div className={className || 'prose prose-sm dark:prose-invert max-w-none message-content'}>
      {showFrontmatterCard && meta && <FrontmatterCard meta={meta} />}
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};
