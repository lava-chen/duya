/**
 * BotBubbleText — Inline markdown text renderer for bot message bubbles.
 *
 * Supports:
 *   **bold**, *italic*, ~~strikethrough~~, `inline code`
 *   [links](url)  — opens in new tab
 *   paragraphs (blank-line separated)
 *   headings (# ## ###)
 *   bullet lists (- item)
 *   numbered lists (1. item)
 *   blockquotes (> quote)
 *   horizontal rules (---)
 *
 * This is intentionally lightweight — no external markdown library.
 */

import React from 'react';

interface BotBubbleTextProps {
  text: string;
  className?: string;
}

/** Split text into paragraphs (double-newline separated). */
function splitParagraphs(text: string): string[] {
  return text.split(/\n\n+/).filter((p) => p.trim().length > 0);
}

/** Process inline formatting within a text run. */
function processInline(text: string): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  // Regex order matters — more specific patterns first.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patterns: [RegExp, (...args: any[]) => React.ReactNode][] = [
    // Inline code: `code`
    [/^`([^`]+)`/, (m) => <code key={key++} className="bot-bubble-inline-code">{m}</code>],
    // Bold + italic: ***text***
    [/^\*\*\*(.+?)\*\*\*/, (m) => <strong key={key++}><em>{m}</em></strong>],
    // Bold: **text**
    [/^\*\*(.+?)\*\*/, (m) => <strong key={key++}>{m}</strong>],
    // Italic: *text* or _text_
    [/^\*(.+?)\*/, (m) => <em key={key++}>{m}</em>],
    [/^_(.+?)_/, (m) => <em key={key++}>{m}</em>],
    // Strikethrough: ~~text~~
    [/^~~(.+?)~~/, (m) => <s key={key++}>{m}</s>],
    // Link: [text](url)
    [/^\[([^\]]+)\]\(([^)]+)\)/, (_m, label, url) => (
      <a key={key++} href={url} target="_blank" rel="noopener noreferrer" className="bot-bubble-link">
        {label}
      </a>
    )],
  ];

  while (remaining.length > 0) {
    let matched = false;

    for (const [regex, render] of patterns) {
      const match = remaining.match(regex);
      if (match) {
        result.push(render(match[1]));
        remaining = remaining.slice(match[0].length);
        matched = true;
        break;
      }
    }

    if (!matched) {
      // Collect plain text until next special char or end
      const nextSpecial = remaining.search(/[`*_~[]/);
      if (nextSpecial === -1) {
        if (remaining.length > 0) result.push(remaining);
        break;
      } else if (nextSpecial === 0) {
        // Escape character at start — just add it as text
        result.push(remaining[0]);
        remaining = remaining.slice(1);
      } else {
        result.push(remaining.slice(0, nextSpecial));
        remaining = remaining.slice(nextSpecial);
      }
    }
  }

  return result;
}

/** Parse a single block-level element (heading, list, blockquote, hr, or paragraph). */
function parseBlock(block: string): React.ReactNode {
  const trimmed = block.trim();

  // Horizontal rule
  if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
    return <hr key={0} className="bot-bubble-hr" />;
  }

  // Headings
  const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)/);
  if (headingMatch) {
    const level = headingMatch[1].length as 1 | 2 | 3;
    const text = headingMatch[2];
    const Tag = `h${level}` as 'h1' | 'h2' | 'h3';
    return <Tag key={0} className={`bot-bubble-heading bot-bubble-heading--${level}`}>{processInline(text)}</Tag>;
  }

  // Blockquote
  if (trimmed.startsWith('>')) {
    const quote = trimmed.replace(/^>\s?/gm, '');
    return <blockquote key={0} className="bot-bubble-blockquote">{parseBlock(quote)}</blockquote>;
  }

  // Bullet list
  if (/^[-*]\s/.test(trimmed)) {
    const items = trimmed.split('\n').filter((l) => /^[-*]\s/.test(l));
    return (
      <ul key={0} className="bot-bubble-list">
        {items.map((item, i) => (
          <li key={i}>{processInline(item.replace(/^[-*]\s/, ''))}</li>
        ))}
      </ul>
    );
  }

  // Numbered list
  if (/^\d+\.\s/.test(trimmed)) {
    const items = trimmed.split('\n').filter((l) => /^\d+\.\s/.test(l));
    return (
      <ol key={0} className="bot-bubble-list bot-bubble-list--ordered">
        {items.map((item, i) => (
          <li key={i}>{processInline(item.replace(/^\d+\.\s/, ''))}</li>
        ))}
      </ol>
    );
  }

  // Paragraph (default)
  return (
    <p key={0} className="bot-bubble-paragraph">
      {processInline(trimmed)}
    </p>
  );
}

/** Parse an array of block strings into React nodes. */
function parseBlocks(blocks: string[]): React.ReactNode[] {
  return blocks.map((block, i) => parseBlock(block));
}

export function BotBubbleText({ text, className = '' }: BotBubbleTextProps) {
  const paragraphs = splitParagraphs(text);

  return (
    <div className={`bot-bubble-text ${className}`}>
      {parseBlocks(paragraphs)}
    </div>
  );
}
