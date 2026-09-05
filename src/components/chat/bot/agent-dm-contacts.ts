/**
 * agent-dm-contacts.ts — peer identity resolution for the DM chip + pair
 * overlay (plan 497). Thin adapter over the sidebar bot contacts list so
 * the DM components never import the hook themselves (keeps them testable
 * with a plain array).
 */

import type { BotContact } from "@/components/layout/sidebar/bot-contacts";

export interface ContactSummaryLike {
  agentId: string;
  name: string;
  avatarUrl?: string;
  avatarColor?: string;
}

/**
 * Resolve display identity for an agent id: the roster contact wins;
 * otherwise fall back to the caller-provided identity (self comes from the
 * chat header, peer from the marker metadata).
 */
export function resolveContactFor(
  contacts: readonly BotContact[],
  agentId: string,
  fallbacks: {
    selfAgentId: string;
    selfName: string;
    selfAvatarUrl?: string;
    selfAvatarColor?: string;
    fallbackPeerName: string;
  },
): ContactSummaryLike {
  const contact = contacts.find((c) => c.agentId === agentId);
  if (contact) {
    return {
      agentId,
      name: contact.name,
      avatarUrl: contact.avatarUrl,
      avatarColor: contact.avatarColor,
    };
  }
  if (agentId === fallbacks.selfAgentId) {
    return {
      agentId,
      name: fallbacks.selfName,
      avatarUrl: fallbacks.selfAvatarUrl,
      avatarColor: fallbacks.selfAvatarColor,
    };
  }
  return { agentId, name: fallbacks.fallbackPeerName };
}
