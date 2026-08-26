import React from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { markdownComponents, MarkdownBaseDirectoryContext } from './markdownComponents';
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

/**
 * Normalize Windows backslash paths inside markdown image/link destinations.
 *
 * react-markdown (via micromark) treats `\` as an escape character, so a
 * Windows absolute path like `![image](C:\Users\foo\shot.png)` gets corrupted:
 * `\p` / `\t` are either silently dropped or interpreted as tab characters,
 * producing a broken src like `C:Users oo shot.png`.
 *
 * We rewrite the backslashes to forward slashes BEFORE the markdown parser
 * sees the text. Only absolute Windows paths (drive letter + colon + backslash)
 * are converted; other destinations (http URLs, relative paths) are untouched.
 */
export function preprocessMarkdownImagePaths(text: string): string {
  return text.replace(
    /(!?\[[^\]]*\]\()([^)]+)(\))/g,
    (match, prefix, url, suffix) => {
      // Only convert if the URL looks like a Windows path (starts with drive letter + colon)
      if (/^[a-zA-Z]:\\/.test(url)) {
        return prefix + url.replace(/\\/g, '/') + suffix;
      }
      return match;
    }
  );
}

/**
 * Repair malformed ATX heading syntax that LLM outputs occasionally produce,
 * so a `###` renders as a heading instead of literal `#` text:
 *
 * 1. Missing space after the marker at line start: `###标题` -> `### 标题`
 * 2. Heading glued to the previous line: `正文### 标题` -> `正文\n### 标题`
 *
 * Only `##`-`######` are repaired — a single `#` is left untouched to avoid
 * mangling `#include` / `#!` / `#hashtag`. Fenced code blocks are skipped so
 * their contents are never rewritten.
 */
export function preprocessMarkdownHeadings(text: string): string {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part, i) => (i % 2 === 1 ? part : repairHeadingSyntax(part)))
    .join('');
}

function repairHeadingSyntax(segment: string): string {
  let out = segment;
  // 1) Missing space after a heading marker at line start.
  out = out.replace(/^(#{2,6})(?!\s)(?!#)/gm, '$1 ');
  // 2) Heading glued to the previous line: ensure a newline precedes it.
  //    Never match a subset of an existing marker (preceded by #) or a
  //    marker already at line start.
  out = out.replace(/(?<![#\n])(?<!^)(#{2,6}\s)/gm, '\n$1');
  return out;
}

/**
 * URL transform that preserves LOCAL media/file references that
 * react-markdown's `defaultUrlTransform` would otherwise strip to an empty
 * string BEFORE our custom `img`/`a` components ever see them:
 *
 * - `duya-file:///...` custom protocol (local image/video embedding)
 * - `data:image/...` / `blob:` (inline previews)
 * - Windows absolute paths (`C:/...`) — micromark parses the drive letter as
 *   an unknown scheme, and the default transform drops every non-allowlisted
 *   scheme, so `![x](E:/a.png)` rendered as `<img alt="x">` with no `src`.
 * - Unix absolute paths (`/home/...`) and internal routes (`/duya/canvas/..`).
 *
 * Everything else keeps the default safe-URL behavior (javascript: etc.
 * are still stripped).
 */
const PRESERVED_URL_RE = /^(?:duya-file:|blob:|data:image\/)/i;

export function preserveLocalUrlTransform(url: string): string {
  if (!url) return url;
  if (PRESERVED_URL_RE.test(url)) return url;
  // Windows absolute path (`C:/...` or `C:\...`).
  if (/^[a-zA-Z]:[\\/]/.test(url)) return url.replace(/\\/g, '/');
  // Unix absolute path or app-internal route.
  if (url.startsWith('/')) return url;
  return defaultUrlTransform(url);
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

interface MarkdownRendererProps {
  children: string;
  className?: string;
  showFrontmatterCard?: boolean;
  /** Directory the markdown source lives in. Relative file links inside
   *  the content resolve against this instead of the active chat thread's
   *  workspace (used by the sidebar file preview so a markdown file's own
   *  links point at its siblings). */
  baseDirectory?: string;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  children,
  className,
  showFrontmatterCard = false,
  baseDirectory,
}) => {
  const processed = preprocessBareImageLinks(
    preprocessMarkdownImagePaths(
      preprocessMarkdownBold(preprocessMarkdownHeadings(children))
    )
  );
  const { meta, content } = parseFrontmatter(processed);

  return (
    <MarkdownBaseDirectoryContext.Provider value={baseDirectory ?? null}>
    <div className={className || 'prose prose-sm dark:prose-invert max-w-none message-content'}>
      {showFrontmatterCard && meta && <FrontmatterCard meta={meta} />}
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: false }]]}
        urlTransform={preserveLocalUrlTransform}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
    </MarkdownBaseDirectoryContext.Provider>
  );
};
