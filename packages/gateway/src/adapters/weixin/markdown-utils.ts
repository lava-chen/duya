/**
 * WeChat Markdown formatting utilities
 *
 * Ported from hermes-agent gateway/platforms/weixin.py.
 * WeChat's Markdown renderer has limitations:
 *   - H1 headers `# Title` → `【Title】`
 *   - H2/H3 headers `## Title` → `**Title**`
 *   - Tables are not supported → converted to list format
 *   - Blank line runs are collapsed (max 1 blank line)
 *   - Fenced code blocks are preserved intact
 */

const _HEADER_RE = /^(#{1,6})\s+(.+?)\s*$/;
const _TABLE_RULE_RE = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/;
const _FENCE_RE = /^```([^\n`]*)\s*$/;
const _MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/;

export const WX_MAX_MESSAGE_LENGTH = 4000;

// ---------------------------------------------------------------------------
// Header rewriting
// ---------------------------------------------------------------------------

export function rewriteHeadersForWeixin(line: string): string {
  const match = _HEADER_RE.exec(line);
  if (!match) return line;
  const level = match[1].length;
  const title = match[2].trim();
  if (level === 1) {
    return `【${title}】`;
  }
  return `**${title}**`;
}

// ---------------------------------------------------------------------------
// Table rewriting
// ---------------------------------------------------------------------------

function splitTableRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split('|').map((cell) => cell.trim());
}

export function rewriteTableBlockForWeixin(lines: string[]): string {
  if (lines.length < 2) return lines.join('\n');
  const headers = splitTableRow(lines[0]);
  if (!headers.length) return lines.join('\n');

  const bodyRows: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    bodyRows.push(splitTableRow(lines[i]));
  }
  if (!bodyRows.length) return lines.join('\n');

  const formattedRows: string[] = [];
  for (const row of bodyRows) {
    const pairs: Array<[string, string]> = [];
    for (let idx = 0; idx < headers.length && idx < row.length; idx++) {
      const label = headers[idx] || `Column ${idx + 1}`;
      const value = row[idx].trim();
      if (value) {
        pairs.push([label, value]);
      }
    }
    if (!pairs.length) continue;
    if (pairs.length === 1) {
      formattedRows.push(`- ${pairs[0][0]}: ${pairs[0][1]}`);
    } else if (pairs.length === 2) {
      formattedRows.push(`- ${pairs[0][0]}: ${pairs[0][1]}`);
      formattedRows.push(`  ${pairs[1][0]}: ${pairs[1][1]}`);
    } else {
      const summary = pairs.map(([k, v]) => `${k}: ${v}`).join(' | ');
      formattedRows.push(`- ${summary}`);
    }
  }
  return formattedRows.length ? formattedRows.join('\n') : lines.join('\n');
}

// ---------------------------------------------------------------------------
// Markdown normalization
// ---------------------------------------------------------------------------

export function normalizeMarkdownBlocks(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;
  let blankRun = 0;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (_FENCE_RE.exec(line.trim())) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      blankRun = 0;
      continue;
    }

    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    if (!line.trim()) {
      blankRun++;
      if (blankRun <= 1) {
        result.push('');
      }
      continue;
    }

    blankRun = 0;
    result.push(line);
  }

  return result.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Block splitting
// ---------------------------------------------------------------------------

export function splitMarkdownBlocks(content: string): string[] {
  if (!content) return [];

  const blocks: string[] = [];
  const lines = content.split('\n');
  const current: string[] = [];
  let inCodeBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (_FENCE_RE.exec(line.trim())) {
      if (!inCodeBlock && current.length) {
        blocks.push(current.join('\n').trim());
        current.length = 0;
      }
      current.push(line);
      inCodeBlock = !inCodeBlock;
      if (!inCodeBlock) {
        blocks.push(current.join('\n').trim());
        current.length = 0;
      }
      continue;
    }

    if (inCodeBlock) {
      current.push(line);
      continue;
    }

    if (!line.trim()) {
      if (current.length) {
        blocks.push(current.join('\n').trim());
        current.length = 0;
      }
      continue;
    }
    current.push(line);
  }

  if (current.length) {
    blocks.push(current.join('\n').trim());
  }
  return blocks.filter((b) => b.length > 0);
}

// ---------------------------------------------------------------------------
// Delivery unit splitting
// ---------------------------------------------------------------------------

export function splitDeliveryUnitsForWeixin(content: string): string[] {
  const units: string[] = [];

  for (const block of splitMarkdownBlocks(content)) {
    const blockLines = block.split('\n');
    if (_FENCE_RE.exec(blockLines[0]?.trim() ?? '')) {
      units.push(block);
      continue;
    }

    const current: string[] = [];
    for (const rawLine of blockLines) {
      const line = rawLine.trimEnd();
      if (!line.trim()) {
        if (current.length) {
          units.push(current.join('\n').trim());
          current.length = 0;
        }
        continue;
      }

      const isContinuation = current.length > 0 && rawLine.startsWith(' ') || rawLine.startsWith('\t');
      if (isContinuation) {
        current.push(line);
        continue;
      }

      if (current.length) {
        units.push(current.join('\n').trim());
      }
      current.length = 0;
      current.push(line);
    }

    if (current.length) {
      units.push(current.join('\n').trim());
    }
  }

  return units.filter((u) => u.length > 0);
}

// ---------------------------------------------------------------------------
// Chat detection
// ---------------------------------------------------------------------------

export function looksLikeChattyLineForWeixin(line: string): boolean {
  const stripped = line.trim();
  if (!stripped) return false;
  if (stripped.length > 48) return false;
  if (line.startsWith(' ') || line.startsWith('\t')) return false;
  if (stripped.startsWith('>') || stripped.startsWith('-') || stripped.startsWith('*') ||
      stripped.startsWith('【') || stripped.startsWith('#') || stripped.startsWith('|')) {
    return false;
  }
  if (_TABLE_RULE_RE.exec(stripped)) return false;
  if (/^\*\*[^*]+\*\*$/.exec(stripped)) return false;
  if (/^\d+\.\s/.exec(stripped)) return false;
  return true;
}

export function looksLikeHeadingLineForWeixin(line: string): boolean {
  const stripped = line.trim();
  if (!stripped) return false;
  if (_HEADER_RE.exec(stripped)) return true;
  return stripped.length <= 24 && (stripped.endsWith(':') || stripped.endsWith('：'));
}

export function shouldSplitShortChatBlockForWeixin(block: string): boolean {
  const lines = block.split('\n').filter((l) => l.trim());
  if (lines.length < 2 || lines.length > 6) return false;
  if (looksLikeHeadingLineForWeixin(lines[0])) return false;
  return lines.every((line) => looksLikeChattyLineForWeixin(line));
}

// ---------------------------------------------------------------------------
// Block packing
// ---------------------------------------------------------------------------

export function packMarkdownBlocksForWeixin(content: string, maxLength: number): string[] {
  if (content.length <= maxLength) return [content];

  const packed: string[] = [];
  let current = '';
  for (const block of splitMarkdownBlocks(content)) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }
    if (current) {
      packed.push(current);
      current = '';
    }
    if (block.length <= maxLength) {
      current = block;
      continue;
    }
    packed.push(...truncateMessage(block, maxLength));
  }
  if (current) {
    packed.push(current);
  }
  return packed;
}

// ---------------------------------------------------------------------------
// Main split function
// ---------------------------------------------------------------------------

export function splitTextForWeixinDelivery(
  content: string,
  maxLength: number = WX_MAX_MESSAGE_LENGTH,
  splitPerLine: boolean = false,
): string[] {
  if (!content) return [];

  if (splitPerLine) {
    if (content.length <= maxLength && !content.includes('\n')) {
      return [content];
    }
    const chunks: string[] = [];
    for (const unit of splitDeliveryUnitsForWeixin(content)) {
      if (unit.length <= maxLength) {
        chunks.push(unit);
      } else {
        chunks.push(...packMarkdownBlocksForWeixin(unit, maxLength));
      }
    }
    return chunks.filter((c) => c.length > 0).length > 0
      ? chunks.filter((c) => c.length > 0)
      : [content];
  }

  if (content.length <= maxLength) {
    if (shouldSplitShortChatBlockForWeixin(content)) {
      return splitDeliveryUnitsForWeixin(content).filter((u) => u.length > 0);
    }
    return [content];
  }
  return packMarkdownBlocksForWeixin(content, maxLength).length > 0
    ? packMarkdownBlocksForWeixin(content, maxLength)
    : [content];
}

// ---------------------------------------------------------------------------
// Format message (main entry point for outbound text)
// ---------------------------------------------------------------------------

export function formatMessage(content: string): string {
  if (!content) return '';

  let result = normalizeMarkdownBlocks(content);

  const lines = result.split('\n');
  const formattedLines: string[] = [];
  let inCodeBlock = false;
  let inTable = false;
  let tableLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (_FENCE_RE.exec(line.trim())) {
      if (inTable) {
        formattedLines.push(rewriteTableBlockForWeixin(tableLines));
        tableLines = [];
        inTable = false;
      }
      inCodeBlock = !inCodeBlock;
      formattedLines.push(line);
      continue;
    }

    if (inCodeBlock) {
      formattedLines.push(line);
      continue;
    }

    if (_TABLE_RULE_RE.exec(line.trim())) {
      if (tableLines.length > 0) {
        tableLines.push(line);
      }
      inTable = true;
      continue;
    }

    if (inTable) {
      if (!line.trim()) {
        formattedLines.push(rewriteTableBlockForWeixin(tableLines));
        tableLines = [];
        inTable = false;
        formattedLines.push('');
        continue;
      }
      tableLines.push(line);
      continue;
    }

    if (tableLines.length > 0) {
      formattedLines.push(rewriteTableBlockForWeixin(tableLines));
      tableLines = [];
    }
    formattedLines.push(rewriteHeadersForWeixin(line));
  }

  if (tableLines.length > 0) {
    formattedLines.push(rewriteTableBlockForWeixin(tableLines));
  }

  result = formattedLines.join('\n').trim();
  result = _MARKDOWN_LINK_RE.exec(result) ? result : result;

  return result;
}

// ---------------------------------------------------------------------------
// Message truncation (for overflow)
// ---------------------------------------------------------------------------

export function truncateMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let breakAt = remaining.lastIndexOf('\n', maxLength);
    if (breakAt <= 0 || breakAt < maxLength / 2) {
      breakAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (breakAt <= 0 || breakAt < maxLength / 2) {
      breakAt = maxLength;
    }
    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Markdown link rewriting: [text](url) → text (url)
// ---------------------------------------------------------------------------

export function rewriteMarkdownLinks(text: string): string {
  return text.replace(_MARKDOWN_LINK_RE, (_match, text, url) => {
    return `${text} (${url})`;
  });
}