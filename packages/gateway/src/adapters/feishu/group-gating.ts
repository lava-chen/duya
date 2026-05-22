﻿import type { FeishuMessageContent, FeishuMention } from './types';
import { parseFeishuContent, isBotMentioned } from './message-utils';

export function isGroupChat(chatType: string): boolean {
  return chatType === 'group' || chatType === 'open_chat' || chatType === 'p2p' || chatType.startsWith('group');
}

export function isPrivateChat(chatType: string): boolean {
  return chatType === 'private' || chatType === 'p2p';
}

export function isFreeResponseChat(chatId: string, freeResponseChatIds?: string[]): boolean {
  if (!freeResponseChatIds || freeResponseChatIds.length === 0) return false;
  return freeResponseChatIds.some(id => id === chatId || id === '*');
}

export function checkUserAllowed(userId: string, allowedUsers?: string[]): boolean {
  if (!allowedUsers || allowedUsers.length === 0) return true;
  return allowedUsers.includes(userId) || allowedUsers.includes('*');
}

export function checkMentionRequirement(messageContent: string, botOpenId: string): boolean {
  if (!botOpenId) return false;
  try {
    const content = parseFeishuContent(messageContent);
    if (content) return isBotMentioned(botOpenId, content);
  } catch {}
  if (typeof messageContent === 'string') {
    const lower = messageContent.toLowerCase();
    return lower.includes(botOpenId.toLowerCase()) || lower.includes('@bot');
  }
  return false;
}

export function shouldRespondInGroup(
  chatId: string,
  chatType: string,
  userId: string,
  botOpenId: string,
  messageContent: string,
  mentions?: FeishuMention[],
  allowedUsers?: string[],
  freeResponseChatIds?: string[],
): { canRespond: boolean; reason?: string } {
  if (!isGroupChat(chatType)) return { canRespond: true };

  const userAllowed = checkUserAllowed(userId, allowedUsers);
  const isFree = isFreeResponseChat(chatId, freeResponseChatIds);

  if (!userAllowed && allowedUsers && allowedUsers.length > 0) {
    return { canRespond: false, reason: 'User not in allowed list' };
  }

  if (isFree) return { canRespond: true };

  const content = parseFeishuContent(messageContent);
  const botMentioned = content
    ? isBotMentioned(botOpenId, content, mentions)
    : checkMentionRequirement(messageContent, botOpenId);

  if (!botMentioned) {
    return { canRespond: false, reason: 'Bot not mentioned' };
  }

  return { canRespond: true };
}