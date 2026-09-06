"use client";

/**
 * Renderer-side client for the unified space search (`db:search:query`).
 *
 * Mirrors the aggregate handler in electron/ipc/db-handlers.ts. The backend
 * returns a flat, kind-tagged list across sessions (SQLite) + bots/routines
 * (config.toml) + message/link content (rollout), capped by a nav/content
 * budget. This module only types and forwards it; all dedupe/budget/order
 * rules live server-side.
 */
export type UnifiedSearchKind = "session" | "bot" | "message" | "link" | "routine";

export interface UnifiedSearchHit {
  /** Dedupe/cache key — not for navigation. */
  key: string;
  kind: UnifiedSearchKind;
  /** Present for session/message/link; drive `setActiveThread(sessionId)`. */
  sessionId?: string;
  botId?: string;
  botName?: string;
  routineId?: string;
  title: string;
  snippet: string;
  messageId?: string;
  seq?: number;
  updatedAt?: number;
}

export const SEARCH_KIND_LABEL: Record<UnifiedSearchKind, string> = {
  session: "聊天",
  bot: "Bot",
  message: "消息",
  link: "链接",
  routine: "例行",
};

export async function searchUnified(
  query: string,
  limit?: number,
): Promise<UnifiedSearchHit[]> {
  const api = window.electronAPI?.search;
  if (!api) return [];
  return (await api.query(query, limit)) as unknown as UnifiedSearchHit[];
}