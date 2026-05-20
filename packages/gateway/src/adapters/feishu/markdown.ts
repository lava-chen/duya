/**
 * Feishu Markdown Renderer
 *
 * Converts Markdown text to Feishu post (rich text) format.
 * Handles code blocks, inline code, bold, italic, links, etc.
 */

const MARKDOWN_SPECIAL_CHARS = '\\`*_{}[]()#+-!|>~';

const MARKDOWN_HINT_RE = /[*_`#\[]/;

const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`([^`]+)`/g;
const BOLD_RE = /\*\*([^*]+)\*\*/g;
const ITALIC_RE = /(?<!\*)\*([^*]+)\*(?!\*)/g;
const CODE_FENCE_RE = /^```/m;

/** Check if text contains markdown syntax */
export function hasMarkdown(text: string): boolean {
  return MARKDOWN_HINT_RE.test(text);
}

/** Escape special characters for Feishu post */
function escapeMarkdownText(text: string): string {
  let result = '';
  for (const char of text) {
    if (MARKDOWN_SPECIAL_CHARS.includes(char)) {
      result += '\\' + char;
    } else {
      result += char;
    }
  }
  return result;
}

interface PostRow {
  tag: string;
  text: string;
}

type PostContent = PostRow[][];

/**
 * Build Feishu post payload from markdown content.
 *
 * Feishu post format:
 * {
 *   "zh_cn": {
 *     "title": "...",
 *     "content": [
 *       [{"tag": "md", "text": "..."}],
 *       [{"tag": "md", "text": "..."}]
 *     ]
 *   }
 * }
 */
export function buildMarkdownPostPayload(content: string): { text: string } {
  const rows = buildMarkdownPostRows(content);

  const postContent: PostContent = rows.map((row) => [{ tag: 'md' as const, text: row.text }]);

  return {
    text: JSON.stringify({
      zh_cn: {
        title: '',
        content: postContent,
      },
    }),
  };
}

/**
 * Build markdown rows, splitting code blocks into separate rows.
 * This prevents Feishu from eating content near fenced code blocks.
 */
function buildMarkdownPostRows(content: string): PostRow[] {
  // If no code blocks, single row
  if (!CODE_BLOCK_RE.test(content)) {
    return [{ tag: 'md', text: content }];
  }

  const rows: PostRow[] = [];
  const lines = content.split('\n');
  let inCodeBlock = false;
  let currentProse: string[] = [];

  const flushProse = () => {
    if (currentProse.length > 0) {
      rows.push({ tag: 'md', text: currentProse.join('\n') });
      currentProse = [];
    }
  };

  for (const line of lines) {
    const isFence = CODE_FENCE_RE.test(line);

    if (isFence) {
      if (!inCodeBlock) {
        // Entering code block
        flushProse();
        rows.push({ tag: 'md', text: line });
        inCodeBlock = true;
      } else {
        // Exiting code block
        rows.push({ tag: 'md', text: line });
        inCodeBlock = false;
      }
    } else if (inCodeBlock) {
      rows.push({ tag: 'md', text: line });
    } else {
      currentProse.push(line);
    }
  }

  flushProse();
  return rows;
}

/**
 * Build text payload (plain text fallback)
 */
export function buildTextPayload(text: string): { text: string } {
  return { text };
}

/**
 * Determine message type and payload based on content.
 *
 * Returns { msgType, payload } where msgType is 'text' or 'post'.
 * 'post' format supports rich markdown rendering.
 */
export function buildOutboundPayload(
  content: string
): { msgType: 'text' | 'post'; payload: { text: string } } {
  if (hasMarkdown(content)) {
    return {
      msgType: 'post',
      payload: buildMarkdownPostPayload(content),
    };
  }

  return {
    msgType: 'text',
    payload: buildTextPayload(content),
  };
}

/**
 * Strip markdown formatting for plain text fallback.
 */
export function stripMarkdown(text: string): string {
  if (!text) return text;

  return (
    text
      // Code blocks: remove fences, keep content
      .replace(/```[\s\S]*?```/g, (match) => {
        const lines = match.split('\n');
        if (lines.length <= 2) return '';
        return lines.slice(1, -1).join('\n');
      })
      // Inline code
      .replace(/`([^`]+)`/g, '$1')
      // Bold
      .replace(/\*\*(.+?)\*\*/g, '$1')
      // Italic
      .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1')
      // Strikethrough
      .replace(/~~(.+?)~~/g, '$1')
      // Links: [text](url) -> text
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
      // Headers
      .replace(/^#{1,6}\s+(.+)$/gm, '$1')
      // List markers
      .replace(/^[\s]*[-*+]\s+/gm, '')
      .replace(/^[\s]*\d+\.\s+/gm, '')
      // Blockquotes
      .replace(/^>\s*/gm, '')
      // Horizontal rules
      .replace(/^[\s]*[-*_]{3,}[\s]*$/gm, '')
      // Collapse blank lines
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}