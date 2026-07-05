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
  const processed = preprocessBareImageLinks(preprocessMarkdownBold(children));
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
