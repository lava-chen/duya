import React from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { markdownComponents, MarkdownBaseDirectoryContext } from './markdownComponents';
import { useTranslation } from '@/hooks/useTranslation';
import { preprocessUnclosedConstructs } from '@/lib/unclosed-constructs';

/**
 * Preprocess markdown text to fix bold syntax issues that the strict
 * CommonMark parser (micromark, used by react-markdown) refuses to render.
 *
 * Two known failure modes are repaired:
 *
 *   1. `** Selection **` — whitespace inside the `**` markers. By spec,
 *      the opening `**` is left-flanking only when NOT followed by
 *      whitespace, and the closing `**` is right-flanking only when
 *      NOT preceded by whitespace. Lines like `** Selection **:` therefore
 *      render as literal asterisks. We trim the whitespace from the
 *      captured content (preserving any other characters) so the markup
 *      becomes `**Selection**` and parses cleanly.
 *
 *   2. `**(content)**` — when the content contains punctuation such as
 *      `(`, `)`, `（`, `）` (or `:*:`-style colon gluing), the flanking
 *      rules can fail too. Inserts zero-width spaces (`\u200B`) inside
 *      the markers so the delimiters regain valid flanking.
 */
export function preprocessMarkdownBold(text: string): string {
  // Match **...** patterns (non-greedy, single line).
  return text.replace(/\*\*([^\n*]+?)\*\*/g, (match, content) => {
    const trimmed = content.replace(/^\s+|\s+$/g, '');
    if (trimmed !== content) {
      // Whitespace padding `** Selection **` → `**Selection**`.
      return `**${trimmed}**`;
    }
    if (/[（）()]/.test(content)) {
      // Parenthetical content `**(text)**` → `**(text)**`.
      return `**\u200B${content}\u200B**`;
    }
    return match;
  });
}

// Chinese (Han/Hiragana/Katakana/Hangul) characters and full-width ASCII
// punctuation. A standalone paragraph that contains CJK is almost
// certainly prose, so the bare-math auto-wrapper leaves it alone.
const CJK_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/;

// Math-only symbols that are vanishingly rare in Chinese/English prose.
// Greek letters, math operators, superscript digits, double-bar norms,
// Unicode minus `−` / mid-dot `·` / cross `×`, plus the literal `^`
// used for superscripts. Used to distinguish a real math expression
// from "x = 5" or "L = Label" style labels.
const MATH_SYMBOL_RE =
  /[πλθμσαβγδεζηικνξορυφχψωΓΔΘΛΞΠΣΦΨΩ∂∇∞∑∫∏√∝→←↑↓∈∉∪∩⊂⊃⊆⊇∅‖±×·÷−≤≥≠≈≡≪≫∠^]/;

// Sentence-ending punctuation. If the line ends with these, it's
// almost certainly prose, not math.
const SENTENCE_END_RE = /[。.，,！!？?；;：:]$/;

// A line is a candidate for bare-math wrapping when it has at least
// one math comparator or assignment (`L =`, `Q ≥`, etc.), or starts
// with a single Greek-letter identifier like `π ∝ ...`. Pure prose
// with `(x + y)` won't satisfy it because there's no anchored
// identifier or math anchor.
const MATH_ANCHOR_RE =
  /^[A-Za-zΑ-Ωα-ω][A-Za-z0-9_\-Α-Ωα-ω]*\s*[=<>≤≥≠≡≈]|^[Α-Ωα-ω]\s*[∝→←↑↓]/;

/**
 * Preprocess a markdown document so that standalone math expressions
 * are recognised by remark-math even when the author omitted the
 * usual `$...$` / `$$...$$` delimiters. This is common in user-written
 * study notes and LLM drafts that were copy-pasted from sources where
 * the equations never had delimiters.
 *
 * Heuristic — a single-line paragraph is rewritten to `$$\n...\n$$`
 * only when ALL of these hold:
 *
 *   1. It is its own paragraph (no list/heading/blockquote prefix).
 *   2. It already lacks math/code markup (`$`, backticks, fences).
 *   3. It starts with a math identifier like `L =` or `argmax (`.
 *   4. It contains at least one math symbol from MATH_SYMBOL_RE.
 *   5. It does not mix in CJK prose.
 *   6. It does not end with sentence-ending punctuation.
 *
 * False positives are unfriendly (KaTeX would surface stray `$` from
 * random text), so the heuristic errs on the strict side and only
 * wraps lines that look unambiguously like equations.
 */
export function preprocessBareMathExpressions(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((paragraph, index, all) => {
      if (index === 0 && /^[ \t]*>/.test(all[index])) return paragraph;
      const trimmed = paragraph.trim();
      if (!trimmed) return paragraph;
      // Skip fenced code blocks, headings, list items, blockquotes.
      if (/^(```|~~~)/.test(trimmed)) return paragraph;
      if (/^#{1,6}\s/.test(trimmed)) return paragraph;
      if (/^[-*+]\s/.test(trimmed)) return paragraph;
      if (/^\d+\.\s/.test(trimmed)) return paragraph;
      if (/^>\s?/.test(trimmed)) return paragraph;
      // Already inside any math/code markup — leave alone.
      if (trimmed.includes('$') || trimmed.includes('`')) return paragraph;
      // Single-line paragraphs only; multi-line blocks are usually prose
      // with embedded expressions that we don't want to rewrite wholesale.
      if (/\n/.test(trimmed)) return paragraph;
      if (!MATH_ANCHOR_RE.test(trimmed)) return paragraph;
      if (!MATH_SYMBOL_RE.test(trimmed)) return paragraph;
      // A CJK-mixed paragraph is usually prose, but if the line still
      // contains a second distinct math symbol we treat it as a mixed
      // math/translation paragraph (e.g. `π ∝ N^α (α=1 近似贪婪)`).
      if (CJK_RE.test(trimmed) && countMathSymbolHits(trimmed) < 2) {
        return paragraph;
      }
      if (SENTENCE_END_RE.test(trimmed)) return paragraph;
      return `\n$$\n${trimmed}\n$$\n`;
    })
    .join('\n\n');
}

function countMathSymbolHits(line: string): number {
  // `MATH_SYMBOL_RE` carries no /g flag (it is also used as a plain
  // "does this line contain any math symbol?" test), so `String.match`
  // would stop at the first hit and every CJK-mixed line would look
  // like it has exactly one symbol — the CJK branch below could then
  // never fire. Match against a global clone for the real count.
  const matches = line.match(new RegExp(MATH_SYMBOL_RE.source, 'g'));
  return matches ? matches.length : 0;
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

/** Sentinel standing in for an inline code span while headings are repaired. */
const INLINE_CODE_PLACEHOLDER = '\u0000';

function repairHeadingSyntax(segment: string): string {
  // Mask inline code spans first: a `###` inside backticks is a literal,
  // not a heading marker, and splitting in front of it would corrupt the
  // rendered list item (see markdown-heading.test.ts). Masking (rather
  // than splitting into independent strings) keeps the "heading glued to
  // the end of a code span" case working, because the sentinel still
  // counts as "some character before the marker".
  const codeSpans: string[] = [];
  let out = segment.replace(/`[^`]*`/g, (span) => {
    codeSpans.push(span);
    return INLINE_CODE_PLACEHOLDER;
  });
  // 1) Missing space after a heading marker at line start.
  out = out.replace(/^(#{2,6})(?!\s)(?!#)/gm, '$1 ');
  // 2) Heading glued to the previous line: ensure a newline precedes it.
  //    Never match a subset of an existing marker (preceded by #) or a
  //    marker already at line start.
  out = out.replace(/(?<![#\n])(?<!^)(#{2,6}\s)/gm, '\n$1');
  if (codeSpans.length === 0) return out;
  return out.replace(new RegExp(INLINE_CODE_PLACEHOLDER, 'g'), () => codeSpans.shift()!);
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
  const processed = preprocessUnclosedConstructs(
    preprocessBareImageLinks(
      preprocessMarkdownImagePaths(
        preprocessBareMathExpressions(
          preprocessMarkdownBold(preprocessMarkdownHeadings(children))
        )
      )
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
