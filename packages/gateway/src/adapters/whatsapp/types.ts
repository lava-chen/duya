/**
 * WhatsApp Adapter Types
 */

export interface WhatsAppMessage {
  id: { _serialized: string; id: string };
  from: string;
  to: string;
  author?: string;
  body: string;
  type: string;
  timestamp: number;
  hasMedia: boolean;
  hasQuotedMsg: boolean;
  getQuotedMessage: () => Promise<{
    id: { _serialized: string };
    body: string;
    from: string;
  }>;
  downloadMedia: () => Promise<{
    mimetype: string;
    data: string;
    filename?: string;
  } | null>;
  getChat: () => Promise<{
    id: { _serialized: string };
    name: string;
    isGroup: boolean;
  }>;
  getMentions: () => Promise<Array<{ id: { _serialized: string } }>>;
}

export interface WhatsAppChat {
  id: { _serialized: string };
  name: string;
  isGroup: boolean;
}

export interface WhatsAppMedia {
  mimetype: string;
  data: string;
  filename?: string;
}

export interface WhatsAppConfigOptions {
  session_path?: string;
  dm_policy?: 'open' | 'allowlist' | 'disabled';
  allow_from?: string[];
  group_policy?: 'open' | 'allowlist' | 'disabled';
  group_allow_from?: string[];
  require_mention?: boolean;
  free_response_chats?: string[];
  mention_patterns?: string[];
}

export interface GatingPolicies {
  dmPolicy: 'open' | 'allowlist' | 'disabled';
  allowFrom: Set<string>;
  groupPolicy: 'open' | 'allowlist' | 'disabled';
  groupAllowFrom: Set<string>;
  requireMention: boolean;
  freeResponseChats: Set<string>;
  mentionPatterns: RegExp[];
}

export function parseGatingPolicies(options?: Record<string, unknown>): GatingPolicies {
  const dmPolicyRaw = (options?.['dm_policy'] as string) || 'open';
  const dmPolicy = ['open', 'allowlist', 'disabled'].includes(dmPolicyRaw)
    ? (dmPolicyRaw as 'open' | 'allowlist' | 'disabled')
    : 'open';

  const allowFromRaw = options?.['allow_from'] as string[] | undefined;

  const groupPolicyRaw = (options?.['group_policy'] as string) || 'open';
  const groupPolicy = ['open', 'allowlist', 'disabled'].includes(groupPolicyRaw)
    ? (groupPolicyRaw as 'open' | 'allowlist' | 'disabled')
    : 'open';

  const groupAllowFromRaw = options?.['group_allow_from'] as string[] | undefined;

  const requireMentionRaw = options?.['require_mention'];
  const requireMention = requireMentionRaw !== false;

  const freeResponseRaw = options?.['free_response_chats'] as string[] | undefined;

  const mentionPatternsRaw = options?.['mention_patterns'] as string[] | undefined;
  const mentionPatterns = (mentionPatternsRaw ?? [])
    .map((p) => {
      try {
        return new RegExp(p, 'i');
      } catch {
        return null;
      }
    })
    .filter((p): p is RegExp => p !== null);

  return {
    dmPolicy,
    allowFrom: new Set(allowFromRaw ?? []),
    groupPolicy,
    groupAllowFrom: new Set(groupAllowFromRaw ?? []),
    requireMention,
    freeResponseChats: new Set(freeResponseRaw ?? []),
    mentionPatterns,
  };
}