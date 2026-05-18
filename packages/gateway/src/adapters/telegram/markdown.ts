/**
 * Markdown conversion utilities for Telegram MarkdownV2
 */

/**
 * Convert standard Markdown to Telegram MarkdownV2.
 * Handles bold, italic, strikethrough, spoiler, links, headers, code blocks.
 * GFM tables are wrapped in ``` fences.
 * Protected regions (code blocks, inline code) are preserved.
 */
export function convertToMarkdownV2(text: string): string {
  const protectedRegions: string[] = [];

  function protect(match: string): string {
    protectedRegions.push(match);
    return `\x00${protectedRegions.length - 1}\x00`;
  }

  let processed = text;

  processed = processed.replace(/```[\s\S]*?```/g, protect);
  processed = processed.replace(/`[^`]+`/g, protect);

  processed = processed.replace(
    /(\|[^\n]+\|[\s\S]*?)(?=\n\n|\n*$)/g,
    (match) => {
      if (/\|[\s\-:]+\|/.test(match)) {
        return protect(`\`\`\`\n${match.trim()}\n\`\`\``);
      }
      return match;
    }
  );

  processed = processed.replace(/^#{1,6}\s+(.+)$/gm, (match, p1) => protect(`*${p1}*`));
  processed = processed.replace(/\*\*([^*]+)\*\*/g, (match, p1) => protect(`*${p1}*`));
  processed = processed.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (match, p1) => protect(`_${p1}_`));
  processed = processed.replace(/~~([^~]+)~~/g, (match, p1) => protect(`~${p1}~`));
  processed = processed.replace(/\|\|([^|]+)\|\|/g, (match, p1) => protect(`||${p1}||`));

  processed = processed.replace(/\[([^\]]+)\]\(([^\)]+(?:\)[^\)]*)?)\)/g, (match, p1, p2) => {
    const escapedUrl = p2.replace(/([()])/g, '\\$1');
    return protect(`[${p1}](${escapedUrl})`);
  });

  processed = processed.replace(/^>\s*(.+)$/gm, (match, p1) => protect(`_${p1}_`));

  const MDV2_ESCAPE = '_*[]()~`>#+-=|{}.!';
  let result = '';
  let inProtected = false;
  let protectedIndex = '';

  for (const char of processed) {
    if (char === '\x00') {
      if (!inProtected) {
        inProtected = true;
        protectedIndex = '';
      } else {
        const idx = parseInt(protectedIndex, 10);
        result += protectedRegions[idx] ?? '';
        inProtected = false;
        protectedIndex = '';
      }
      continue;
    }

    if (inProtected) {
      protectedIndex += char;
      continue;
    }

    result += MDV2_ESCAPE.includes(char) ? '\\' + char : char;
  }

  return result;
}

export function escapeMarkdownV2(text: string): string {
  const MDV2_ESCAPE_CHARS = '_*[]()~`>#+-=|{}.!';
  let result = '';
  for (const char of text) {
    result += MDV2_ESCAPE_CHARS.includes(char) ? '\\' + char : char;
  }
  return result;
}
