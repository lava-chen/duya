/**
 * Pure helpers extracted from DuyaAgent.ts. Each function is self-contained
 * (no `this` dependency) and may be reused by other modules.
 */
import type {
  AgentProfile,
} from '../../agent-profile/types.js';
import type { MailboxApplyMode, MailboxRow } from '../../session/db.js';
import type {
  FileAttachment,
  Message,
  MessageContent,
  Tool,
} from '../../types.js';

/** Empty set used by _resolveTools (no tools discovered yet at startup). */
export const EMPTY_DISCOVERED: ReadonlySet<string> = new Set();

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

export function collectRecentImageAttachments(messages: Message[]): Array<{
  name: string;
  path?: string;
  url?: string;
  type: string;
}> {
  const recent: Array<{
    name: string;
    path?: string;
    url?: string;
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

export type RuntimeMailboxDecision =
  | { action: 'continue'; absorbed: boolean }
  | { action: 'soft_stop'; summary: string }
  | { action: 'hard_replace'; replacement: string };

export interface RuntimeMailboxClaim {
  rows: MailboxRow[];
  claimTokens: string[];
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
        source === 'custom'
      ) {
        return false;
      }
    }
    return true;
  });
}

/**
 * FNV-1a 32-bit fingerprint of the stable-user prefix (system prompt +
 * tool schema names). Used to expose a stable cache key to
 * `onSystemPromptReady` observers so they can detect a reachable
 * provider cache breakpoint without coupling to the provider adapter.
 */
export function computeCachePlanFingerprint(systemPrompt: string, tools: Tool[]): string {
  const source = `${systemPrompt}\n${tools.map((t) => t.name).join(',')}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `cache-v1-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function chooseMailboxApplyMode(_row: MailboxRow): MailboxApplyMode {
  return 'runtime_instruction';
}

/**
 * Build the identity block prepended to the system prompt when an agent profile is applied.
 * This tells the LLM clearly what role it should play.
 *
 * When the profile provides `identityPrompt`, that single concise
 * sentence is used verbatim — it lets a preset express a precise role
 * (e.g. the gateway relay agent) without the generic name/description
 * scaffolding. Otherwise fall back to the generic block.
 */
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
