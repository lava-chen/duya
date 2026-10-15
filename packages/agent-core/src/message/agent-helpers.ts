import type { Message, MessageContent } from '@duya/agent-protocol/transcript';


export function extractTextFromContent(content: string | readonly MessageContent[]): string {
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') {
      parts.push((block as { text: string }).text || '')
    } else if (block.type === 'tool_use') {
      const b = block as unknown as { name: string }
      parts.push(`[Tool call: ${b.name || 'unknown'}]`)
    } else if (block.type === 'tool_result') {
      const b = block as unknown as { content: string | Array<{ type: string; text: string }> }
      const resultText = typeof b.content === 'string'
        ? b.content
        : Array.isArray(b.content)
          ? b.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
          : ''
      parts.push(`[Tool result: ${resultText.slice(0, 300)}]`)
    }
  }
  return parts.join('\n')
}


/**
 * Extract the last *real* user query from a message list, skipping transient
 * synthetic turns (mailbox, todo gate, background notifications, etc.) that
 * the harness injected rather than the user typed. Mirrors grok's
 * `extract_last_real_user_query` / `last_user_anchor`: synthetic messages are
 * identified purely by `metadata.runtimeContext`, never by parsing text.
 * Returns undefined when no real user message with text exists.
 */
export function lastRealUserQuery(messages: readonly Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    const meta = m.metadata as Record<string, unknown> | undefined;
    if (meta?.runtimeContext === true) continue;
    const text = extractTextFromContent(m.content).trim();
    if (text.length > 0) return text;
  }
  return undefined;
}


/**
 * Text of the last assistant message with non-empty content. Shared by the
 * loop-hook builtin nudges (premature-stop, reply-fingerprint) that
 * pattern-match the model's closing statement before finalize.
 */
export function lastAssistantTextOf(
  messages: ReadonlyArray<{ role?: string; content?: string | readonly unknown[] | null }>,
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'assistant') continue;
    if (m.content === undefined || m.content === null) continue;
    const text =
      typeof m.content === 'string'
        ? m.content
        : extractTextFromContent(m.content as readonly MessageContent[]);
    if (text && text.trim().length > 0) return text;
  }
  return undefined;
}


export function persistableMessages(messages: Message[]): Message[] {
  return messages.filter((message) => {
    const meta = message.metadata as Record<string, unknown> | undefined;
    // Transient runtime context (mailbox instructions, background task
    // notifications) is shown to the model for the current turn but never
    // persisted to the append-only history. Durable attachment context
    // (source='attachment') is intentionally kept.
    if (meta?.runtimeContext === true) {
      const source = meta.source;
      if (
        source === 'mailbox' ||
        source === 'background_notification' ||
        source === 'custom' ||
        source === 'todo_gate' ||
        source === 'auto_continue' ||
        source === 'dead_loop_nudge' ||
        source === 'premature_stop'
      ) {
        return false;
      }
    }
    return true;
  });
}

import type { AgentProfile } from '../agent-profile.js';
import type { FileAttachment } from '@duya/agent-protocol';

export function collectRecentImageAttachments(messages: Message[]): Array<{
  name: string;
  path?: string | undefined;
  url?: string | undefined;
  type: string;
}> {
  const recent: Array<{
    name: string;
    path?: string | undefined;
    url?: string | undefined;
    type: string;
  }> = [];
  const seen = new Set<string>();

  for (let i = messages.length - 1; i >= 0; i--) {
    const attachments = messages[i]?.attachments as FileAttachment[] | undefined;
    if (!attachments || attachments.length === 0) continue;

    for (const attachment of [...attachments].reverse()) {
      if (!attachment?.type?.startsWith('image/')) continue;
      const source = attachment.path || attachment.url;
      if (!source) continue;

      const dedupeKey = `${attachment.name}::${source}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      recent.push({
        name: attachment.name,
        path: attachment.path,
        url: attachment.url,
        type: attachment.type,
      });
    }
  }

  return recent;
}

export function computeCachePlanFingerprint(systemPrompt: string, tools: readonly { name: string }[]): string {
  const source = `${systemPrompt}\n${tools.map((t) => t.name).join(',')}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `cache-v1-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function buildAgentIdentityBlock(profile: AgentProfile): string {
  if (profile.identityPrompt) {
    return profile.identityPrompt;
  }

  const lines: string[] = [
    `You are a "${profile.name}" agent.`,
  ];

  if (profile.description) {
    lines.push(`Your role: ${profile.description}.`);
  }

  return lines.join('\n');
}
