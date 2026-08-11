/**
 * Markdown conversion utilities for Telegram MarkdownV2
 *
 * Faithful TypeScript port of hermes-agent's `format_message` (see
 * `hermes/plugins/platforms/telegram/adapter.py`). Handles:
 *   0. GFM pipe tables → bold-heading + bullet groups (Telegram has no table
 *      syntax; raw pipes render as noisy backslash-pipes).
 *   1. Fenced ``` code blocks → protected, internal `\` and `` ` `` escaped.
 *   2. Inline `code` → protected, internal `\` escaped.
 *   3. Links `[text](url)` → display text escaped; URL only escapes `)` and
 *      `\`.
 *   4. Headers `## H` → bold `*H*`.
 *   5. Bold `**text**` → `*text*`.
 *   6. Italic `*text*` → `_text_`.
 *   7. Strikethrough `~~text~~` → `~text~`.
 *   8. Spoiler `||text||` → `||text||` (protected from `|` escaping).
 *   9. Blockquotes `>`, expandable `**> ... ||`.
 *   10. Global escape of remaining special chars (outside protected regions).
 *   11. Restore placeholders in reverse insertion order so nested refs
 *      resolve correctly.
 *   12. Safety net: escape bare `(`, `)`, `{`, `}` outside code spans
 *      (preserves link URL parens).
 */

const MDV2_SPECIAL_CHARS = '_*[]()~`>#+-=|{}.!\\';

/** Escape every Telegram MarkdownV2 special character. */
export function escapeMarkdownV2(text: string): string {
  if (!text) return text;
  let result = '';
  for (const ch of text) {
    result += MDV2_SPECIAL_CHARS.includes(ch) ? '\\' + ch : ch;
  }
  return result;
}

// ─── Table detection + conversion ────────────────────────────────────────────

const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*){1,}\|?\s*$/;

function isTableRow(line: string): boolean {
  const stripped = line.trim();
  return stripped.length > 0 && stripped.includes('|');
}

function splitMarkdownTableRow(line: string): string[] {
  // GFM rows: | a | b | c |   (leading/trailing pipes optional)
  const stripped = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return stripped.split('|').map((c) => c.trim());
}

function renderTableBlock(block: string[]): string {
  if (block.length < 3) return block.join('\n');

  const headers = splitMarkdownTableRow(block[0]);
  if (headers.length < 2) return block.join('\n');

  const firstDataRow = block.length > 2 ? splitMarkdownTableRow(block[2]) : [];
  const hasRowLabelCol = firstDataRow.length === headers.length + 1;

  const rendered: string[] = [];
  let rowIndex = 1;
  for (let i = 2; i < block.length; i++) {
    const cells = splitMarkdownTableRow(block[i]);
    let heading: string;
    let dataCells: string[];
    if (hasRowLabelCol) {
      heading = cells.length > 0 && cells[0] ? cells[0] : `Row ${rowIndex}`;
      dataCells = cells.slice(1);
    } else {
      heading = cells.find((c) => c) || `Row ${rowIndex}`;
      dataCells = cells;
    }
    if (dataCells.length < headers.length) {
      dataCells = dataCells.concat(Array(headers.length - dataCells.length).fill(''));
    } else if (dataCells.length > headers.length) {
      dataCells = dataCells.slice(0, headers.length);
    }
    const bullets: string[] = [];
    for (let j = 0; j < headers.length; j++) {
      if (!hasRowLabelCol && dataCells[j] === heading) continue;
      bullets.push(`• ${headers[j]}: ${dataCells[j]}`);
    }
    const groupLines = [`**${heading}**`, ...bullets];
    rendered.push(groupLines.join('\n'));
    rowIndex++;
  }
  return rendered.join('\n\n');
}

function convertMarkdownTablesToBullets(text: string): string {
  if (!text.includes('|') || !text.includes('-')) return text;
  const lines = text.split('\n');
  const out: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    const stripped = line.trimStart();
    if (stripped.startsWith('```')) {
      inFence = !inFence;
      out.push(line);
      i++;
      continue;
    }
    if (inFence) {
      out.push(line);
      i++;
      continue;
    }
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      TABLE_SEPARATOR_RE.test(lines[i + 1])
    ) {
      const block = [line, lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j])) {
        block.push(lines[j]);
        j++;
      }
      out.push(renderTableBlock(block));
      i = j;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}

// ─── Main conversion (hermes format_message port) ───────────────────────────

/**
 * Convert standard markdown to Telegram MarkdownV2 format.
 *
 * See module header for the full 12-step pipeline. Returns the input
 * unchanged when empty.
 */
export function convertToMarkdownV2(content: string): string {
  if (!content) return content;

  const placeholders = new Map<number, string>();
  let counter = 0;
  const protect = (value: string): string => {
    const key = counter++;
    placeholders.set(key, value);
    return `\x00PH${key}\x00`;
  };

  let text = content;

  // 0) Rewrite GFM pipe tables → bold-heading + bullet groups.
  text = convertMarkdownTablesToBullets(text);

  // 1) Protect fenced code blocks; escape internal `\` and `` ` ``.
  text = text.replace(
    /(```[^\n]*\n[\s\S]*?```)/g,
    (m) => {
      const newlineIdx = m.indexOf('\n');
      const openEnd = newlineIdx >= 0 && newlineIdx > 3 ? newlineIdx + 1 : 3;
      const opening = m.slice(0, openEnd);
      const bodyAndClose = m.slice(openEnd);
      const body = bodyAndClose.slice(0, -3).replace(/\\/g, '\\\\').replace(/`/g, '\\`');
      return protect(opening + body + '```');
    },
  );

  // 2) Protect inline code; escape internal `\`.
  text = text.replace(/`[^`]+`/g, (m) => protect(m.replace(/\\/g, '\\\\')));

  // 3) Convert markdown links: escape display, escape only `)` and `\` in URL.
  text = text.replace(/\[([^\]]+)\]\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, (_m, display, url) => {
    const safeDisplay = escapeMarkdownV2(display);
    const safeUrl = url.replace(/\\/g, '\\\\').replace(/\)/g, '\\)');
    return protect(`[${safeDisplay}](${safeUrl})`);
  });

  // 4) Convert headers `## H` → bold `*H*`.
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (_m, inner) => {
    const stripped = inner.trim().replace(/\*\*(.+?)\*\*/g, '$1');
    return protect(`*${escapeMarkdownV2(stripped)}*`);
  });

  // 5) Convert bold `**text**` → `*text*`.
  text = text.replace(/\*\*(.+?)\*\*/g, (_m, inner) => protect(`*${escapeMarkdownV2(inner)}*`));

  // 6) Convert italic `*text*` → `_text_` (avoid crossing newlines).
  text = text.replace(/\*([^*\n]+)\*/g, (_m, inner) => protect(`_${escapeMarkdownV2(inner)}_`));

  // 7) Strikethrough `~~text~~` → `~text~`.
  text = text.replace(/~~(.+?)~~/g, (_m, inner) => protect(`~${escapeMarkdownV2(inner)}~`));

  // 8) Spoiler `||text||` → `||text||` (protected so `|` not escaped).
  text = text.replace(/\|\|(.+?)\|\|/g, (_m, inner) => protect(`||${escapeMarkdownV2(inner)}||`));

  // 9) Blockquotes (including expandable `**> ... ||`).
  text = text.replace(
    /^((?:\*\*)?>{1,3}) (.+)$/gm,
    (_m, prefix, content) => {
      if (prefix.startsWith('**') && content.endsWith('||')) {
        return protect(`${prefix} ${escapeMarkdownV2(content.slice(0, -2))}||`);
      }
      return protect(`${prefix} ${escapeMarkdownV2(content)}`);
    },
  );

  // 10) Escape remaining special characters in plain text.
  text = escapeMarkdownV2(text);

  // 11) Restore placeholders in reverse insertion order.
  for (const [key, value] of [...placeholders.entries()].reverse()) {
    text = text.replace(`\x00PH${key}\x00`, value);
  }

  // 12) Safety net: escape bare `(`, `)`, `{`, `}` outside code spans.
  // Code spans (fenced ``` and inline ``) are left untouched.
  const codeSpanSplit = text.split(/(```[\s\S]*?```|`[^`]+`)/g);
  const safeParts: string[] = [];
  for (let i = 0; i < codeSpanSplit.length; i++) {
    const segment = codeSpanSplit[i];
    if (i % 2 === 1) {
      safeParts.push(segment);
      continue;
    }
    safeParts.push(
      segment.replace(/[(){}]/g, (ch, offset) => {
        if (offset > 0 && segment[offset - 1] === '\\') return ch;
        if (ch === '(' && offset > 0 && segment[offset - 1] === ']') return ch;
        // `)` that closes a markdown link URL — don't escape if it's the
        // matching close for an unescaped `(` inside `[..](...`.
        if (ch === ')') {
          const before = segment.slice(0, offset);
          if (before.includes('](')) {
            let depth = 0;
            for (let j = offset - 1; j >= Math.max(0, offset - 2000); j--) {
              if (segment[j] === '(') {
                depth--;
                if (depth < 0) {
                  if (j > 0 && segment[j - 1] === ']') return ch;
                  break;
                }
              } else if (segment[j] === ')') {
                depth++;
              }
            }
          }
        }
        return '\\' + ch;
      }),
    );
  }
  text = safeParts.join('');

  return text;
}