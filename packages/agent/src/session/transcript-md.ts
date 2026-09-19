/**
 * transcript-md — session transcript rendering (plan 554, minimax
 * `/export`/`/copy`/`/transcript` parity).
 *
 * A single renderer shared by the CLI slash commands and the desktop
 * deterministic-command intercept: Message[] → compact Markdown. Tool
 * traffic (tool_use / tool_result / thinking) is COLLAPSED to one-liners —
 * the file is meant to be read, not replayed; a full replay already lives
 * in the rollout JSONL (plan 441).
 */

import type { Message, MessageContent } from '../types.js';

const MAX_TOOL_LINE_CHARS = 160;

function truncateLine(text: string, maxChars = MAX_TOOL_LINE_CHARS): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}…`;
}

/** Flatten one message's content blocks into markdown body lines. */
function renderBlocks(content: MessageContent[]): string[] {
  const lines: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if ('text' in block && typeof (block as { text?: unknown }).text === 'string') {
      const text = (block as { text: string }).text.trim();
      if (text) lines.push(text);
      continue;
    }
    if ('thinking' in block && typeof (block as { thinking?: unknown }).thinking === 'string') {
      const thinking = (block as { thinking: string }).thinking.trim();
      if (thinking) {
        lines.push('<details><summary>thinking</summary>');
        lines.push('', truncateLine(thinking, 600), '', '</details>');
      }
      continue;
    }
    if ('name' in block && typeof (block as { name?: unknown }).name === 'string') {
      const toolUse = block as { name: string; input?: unknown };
      let inputSummary = '';
      try {
        inputSummary = JSON.stringify(toolUse.input ?? {});
      } catch {
        inputSummary = '(unserializable input)';
      }
      lines.push(`- ⚙️ \`${toolUse.name}\` — \`${truncateLine(inputSummary, 120)}\``);
      continue;
    }
    if ('type' in block && (block as { type?: unknown }).type === 'tool_result') {
      const tr = block as { content?: string | MessageContent[] };
      let resultText = '';
      if (typeof tr.content === 'string') {
        resultText = tr.content;
      } else if (Array.isArray(tr.content)) {
        resultText = tr.content
          .map((nested) =>
            nested && typeof nested === 'object' && 'text' in nested && typeof (nested as { text?: unknown }).text === 'string'
              ? (nested as { text: string }).text
              : '',
          )
          .filter(Boolean)
          .join(' ');
      }
      lines.push(`  ↳ \`${truncateLine(resultText, 140)}\``);
      continue;
    }
    if ('source' in block || ('type' in block && (block as { type?: unknown }).type === 'image')) {
      lines.push('- 🖼️ (image attachment)');
    }
  }
  return lines;
}

function renderMessage(message: Message): string[] {
  const role = message.role === 'assistant' ? '🤖 Assistant' : message.role === 'user' ? '🧑 User' : message.role;
  const header = `### ${role}`;
  if (typeof message.content === 'string') {
    const text = message.content.trim();
    return text ? [header, '', text, ''] : [];
  }
  const body = renderBlocks(message.content);
  return body.length > 0 ? [header, '', ...body, ''] : [];
}

export interface TranscriptMarkdownOptions {
  /** Session identifier surfaced in the header (truncated automatically). */
  sessionId?: string;
  /** Whether the header includes counts (default true). */
  header?: boolean;
}

/** Render the full transcript as Markdown. Never throws. */
export function buildTranscriptMarkdown(
  messages: readonly Message[],
  options: TranscriptMarkdownOptions = {},
): string {
  const lines: string[] = ['# Duya Transcript', ''];
  if (options.header !== false) {
    if (options.sessionId) {
      lines.push(`- Session: ${options.sessionId.slice(0, 40)}`);
    }
    lines.push(`- Exported: ${new Date().toISOString()}`);
    lines.push(`- Messages: ${messages.length}`);
    lines.push('');
  }
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    lines.push(...renderMessage(message));
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * The last assistant reply as plain text (for `/copy`). Tool blocks are
 * skipped — the user wants the prose. Returns undefined when the transcript
 * has no assistant text yet.
 */
export function getLastReplyText(messages: readonly Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== 'assistant') continue;
    if (typeof message.content === 'string') {
      const text = message.content.trim();
      if (text) return text;
      continue;
    }
    const parts: string[] = [];
    for (const block of message.content) {
      if (block && typeof block === 'object' && 'text' in block && typeof (block as { text?: unknown }).text === 'string') {
        parts.push((block as { text: string }).text);
      }
    }
    const text = parts.join('\n').trim();
    if (text) return text;
  }
  return undefined;
}
