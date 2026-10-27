/**
 * Platform-agnostic inbound access gating.
 *
 * Every channel decides the same two questions: "may this DM be answered?" and
 * "may this group message be answered?". The answers depend on four policies
 * (open / allowlist / pairing / disabled) plus a mention requirement, and the
 * policies are configured from `PlatformConfig.options` using snake_case keys
 * that came from the original per-adapter implementations.
 *
 * Keeping one implementation means a new channel is gated correctly on day
 * one instead of shipping with "everyone can talk to the bot in every group",
 * which is what happens when an adapter forgets to implement it at all.
 */

export type AccessPolicy = 'open' | 'allowlist' | 'pairing' | 'disabled';

const ACCESS_POLICIES: readonly AccessPolicy[] = ['open', 'allowlist', 'pairing', 'disabled'];

export interface GatingOptions {
  dmPolicy: AccessPolicy;
  allowFrom: Set<string>;
  groupPolicy: AccessPolicy;
  groupAllowFrom: Set<string>;
  /** Groups/channels where the mention requirement is waived. */
  freeResponseChats: Set<string>;
  requireMention: boolean;
  mentionPatterns: RegExp[];
}

export interface GatingInput {
  /** Platform user ID of the sender. */
  senderId: string;
  /** Chat/group/channel ID the message arrived in. */
  chatId: string;
  isGroup: boolean;
  /** Message text, used for the mention requirement and slash bypass. */
  text?: string;
  /** Adapter-computed mention verdict (native mention markup, reply-to-bot, …). */
  botMentioned?: boolean;
}

/**
 * - `allow`         → deliver to the agent,
 * - `deny`          → drop silently,
 * - `pending-pairing` → the message came from an unknown DM under the
 *   `pairing` policy; deliver it and let the host-side allowlist decide
 *   (the host owns the pairing code exchange).
 */
export type GatingVerdict = 'allow' | 'deny' | 'pending-pairing';

function toAccessPolicy(value: unknown, fallback: AccessPolicy): AccessPolicy {
  return typeof value === 'string' && (ACCESS_POLICIES as readonly string[]).includes(value)
    ? (value as AccessPolicy)
    : fallback;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function toPatterns(value: unknown): RegExp[] {
  return toStringArray(value)
    .map((raw) => {
      try {
        return new RegExp(raw, 'i');
      } catch {
        return null;
      }
    })
    .filter((p): p is RegExp => p !== null);
}

/** Parse `PlatformConfig.options` into normalized gating policies. */
export function parseGatingOptions(options?: Record<string, unknown>): GatingOptions {
  return {
    dmPolicy: toAccessPolicy(options?.['dm_policy'], 'open'),
    allowFrom: new Set(toStringArray(options?.['allow_from'])),
    groupPolicy: toAccessPolicy(options?.['group_policy'], 'open'),
    groupAllowFrom: new Set(toStringArray(options?.['group_allow_from'])),
    freeResponseChats: new Set(toStringArray(options?.['free_response_chats'])),
    requireMention: options?.['require_mention'] !== false,
    mentionPatterns: toPatterns(options?.['mention_patterns']),
  };
}

function matchesPattern(text: string | undefined, patterns: RegExp[]): boolean {
  if (!text || patterns.length === 0) return false;
  return patterns.some((p) => p.test(text));
}

/**
 * Evaluate gating for one inbound message.
 *
 * Slash commands always bypass the mention requirement so `/help` works in a
 * busy group, but never bypass the allowlist.
 */
export function evaluateGating(policies: GatingOptions, input: GatingInput): GatingVerdict {
  if (!input.isGroup) {
    switch (policies.dmPolicy) {
      case 'disabled':
        return 'deny';
      case 'allowlist':
        return policies.allowFrom.has(input.senderId) ? 'allow' : 'deny';
      case 'pairing':
        return policies.allowFrom.has(input.senderId) ? 'allow' : 'pending-pairing';
      case 'open':
      default:
        return 'allow';
    }
  }

  switch (policies.groupPolicy) {
    case 'disabled':
      return 'deny';
    case 'allowlist':
      if (!policies.groupAllowFrom.has(input.chatId)) return 'deny';
      break;
    case 'pairing':
      if (!policies.groupAllowFrom.has(input.chatId)) return 'deny';
      break;
    case 'open':
    default:
      break;
  }

  if (policies.freeResponseChats.has(input.chatId)) return 'allow';
  if (input.text?.startsWith('/')) return 'allow';
  if (!policies.requireMention) return 'allow';
  if (input.botMentioned) return 'allow';
  if (matchesPattern(input.text, policies.mentionPatterns)) return 'allow';
  return 'deny';
}

/**
 * Remove mention tokens from the delivered text so the agent does not see
 * "@bot /status" as content. Accepts literal tokens, not regexes.
 */
export function stripMentionTokens(text: string, tokens: string[]): string {
  let out = text;
  for (const token of tokens) {
    if (!token) continue;
    out = out.replace(new RegExp(escapeRegExp(token), 'gi'), ' ');
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
