/**
 * Gating policies for WhatsApp adapter
 */

import type { GatingPolicies, WhatsAppMessage } from './types.js';

export function shouldProcessMessage(
  msg: WhatsAppMessage,
  chatId: string,
  isGroup: boolean,
  policies: GatingPolicies,
  botNumber: string
): boolean {
  if (isGroup) {
    if (!isGroupAllowed(chatId, policies)) {
      return false;
    }

    if (policies.freeResponseChats.has(chatId)) {
      return true;
    }

    if (msg.body?.startsWith('/')) {
      return true;
    }

    if (!policies.requireMention) {
      return true;
    }

    if (isBotMentioned(msg, botNumber)) {
      return true;
    }

    if (matchesMentionPatterns(msg.body, policies.mentionPatterns)) {
      return true;
    }

    return false;
  } else {
    return isDmAllowed(msg.from, policies);
  }
}

function isDmAllowed(senderId: string, policies: GatingPolicies): boolean {
  if (policies.dmPolicy === 'disabled') return false;
  if (policies.dmPolicy === 'allowlist') return policies.allowFrom.has(senderId);
  return true;
}

function isGroupAllowed(chatId: string, policies: GatingPolicies): boolean {
  if (policies.groupPolicy === 'disabled') return false;
  if (policies.groupPolicy === 'allowlist') return policies.groupAllowFrom.has(chatId);
  return true;
}

function isBotMentioned(msg: WhatsAppMessage, botNumber: string): boolean {
  if (!botNumber) return false;

  const bareNumber = botNumber.split('@')[0];
  const body = msg.body?.toLowerCase() ?? '';

  return bareNumber ? body.includes(bareNumber.toLowerCase()) : false;
}

function matchesMentionPatterns(text: string, patterns: RegExp[]): boolean {
  if (!patterns.length) return false;
  return patterns.some((p) => p.test(text));
}

export function cleanBotMentionText(text: string, botNumber: string): string {
  if (!text || !botNumber) return text;

  const bareNumber = botNumber.split('@')[0];
  if (!bareNumber) return text;

  return text.replace(new RegExp(`@${bareNumber}\\b[,:\\-]*\\s*`, 'gi'), '').trim() || text;
}