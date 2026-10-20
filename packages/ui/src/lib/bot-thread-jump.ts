"use client";

import {
  deriveBotPlaceholderThreadId,
  matchesBotThread,
} from "@/components/layout/sidebar/bot-contacts";
import { useConversationStore } from "@/stores/conversation-store";

/**
 * Resolve the thread id to open for a bot search hit, mirroring the sidebar's
 * bot-open fast path: use the bot's bound (persistent) thread when one exists,
 * otherwise the placeholder thread the app lazily binds on first open.
 */
export function resolveBotOpenThreadId(agentId: string): string {
  const threads = useConversationStore.getState().threads;
  const bound = threads.find((t) => matchesBotThread(agentId, t.id));
  return bound?.id ?? deriveBotPlaceholderThreadId(agentId);
}