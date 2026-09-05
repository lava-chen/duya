'use client';
/**
 * useBotDirectTranscript — Plan 489 P0.3
 *
 * The bot-direct chat surface (BotDirectChatView) is required to show
 * ONLY messages produced by SendMessage. This hook drives that
 * projection at the data layer, not just the UI layer:
 *
 *   1. On mount, fetches the bot-direct transcript via IPC
 *      `db:message:botDirectGetTranscript` (the server applies the
 *      source filter — see electron/ipc/db-handlers.ts).
 *   2. Subscribes to the existing `message:new` SSE event and merges
 *      rows whose `source` is `'send_message'` or `'user'`. Rows with
 *      `'tool_use' | 'thinking' | 'scratchpad' | 'system'` (and any
 *      other source) are discarded. This means even if a bot's
 *      `message:append` IPC is replayed to the renderer (it always is,
 *      through the legacy message:new broadcast), only the safe rows
 *      land in the hook's state.
 *   3. Cleans up on unmount / session change.
 *
 * The hook is independent of `useConversationStore` — the workspace
 * store still subscribes to the unfiltered stream for ChatView. The
 * bot-direct view is fully self-contained so the data-layer guarantee
 * cannot regress by a future refactor of conversation-store.
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import { getBotDirectTranscriptIPC, dbMessageToMessage, type DbMessage as DbMessageRow, type Message as IpcMessage } from '@/lib/ipc-client';
import type { Message } from '@/types/message';

const BOT_DIRECT_VISIBLE_SOURCES: ReadonlySet<string> = new Set([
  'send_message',
  'user',
  // Plan 477 P4.4: bot→bot DM marker cards (sent + received directions).
  'agent_dm',
]);

function isBotDirectVisible(source: string | null | undefined): boolean {
  if (!source) return false;
  return BOT_DIRECT_VISIBLE_SOURCES.has(source);
}

/**
 * Bridge the IPC Message shape (camelCase, `createdAt`) into the UI
 * Message shape (`timestamp`, `tool_call_id`, etc.). The display layer
 * expects the renderer-facing type; the IPC layer carries the wire shape.
 */
function ipcMessageToUiMessage(m: IpcMessage): Message {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    displayContent: m.displayContent,
    name: m.name ?? undefined,
    tool_call_id: m.toolCallId ?? undefined,
    timestamp: m.createdAt,
    tokenUsage: m.tokenUsage
      ? typeof m.tokenUsage === 'string'
        ? (JSON.parse(m.tokenUsage) as Message['tokenUsage'])
        : (m.tokenUsage as unknown as Message['tokenUsage'])
      : null,
    msgType: (m.msgType || undefined) as Message['msgType'],
    thinking: m.thinking ?? undefined,
    toolName: m.toolName ?? undefined,
    toolInput: m.toolInput ?? undefined,
    parentToolCallId: m.parentToolCallId ?? undefined,
    vizSpec: m.vizSpec ?? undefined,
    status: m.status ?? undefined,
    seqIndex: m.seqIndex ?? undefined,
    seq: m.seqIndex ?? undefined,
    durationMs: m.durationMs ?? undefined,
    subAgentId: m.subAgentId ?? undefined,
    attachments: m.attachments ?? undefined,
    source: m.source ?? null,
    sendMessageMeta: m.sendMessageMeta ?? null,
    agentDmMeta: m.agentDmMeta ?? null,
  };
}

export interface UseBotDirectTranscriptResult {
  messages: Message[];
  isLoading: boolean;
  error: string | null;
  refresh: (afterSeq?: number) => Promise<void>;
  lastSeq: number | null;
}

export function useBotDirectTranscript(
  sessionId: string | null
): UseBotDirectTranscriptResult {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Plan 491 P1.2: lastSeq cursor for windowed replay on reconnection
  const [lastSeq, setLastSeq] = useState<number | null>(null);
  // Keep the latest messages in a ref so the SSE handler can dedup by id.
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;

  const refresh = useCallback(async (afterSeq?: number) => {
    if (!sessionId) {
      setMessages([]);
      setLastSeq(null);
      return;
    }
    // Bail out when IPC is not wired (jsdom test runner, web build).
    // The hook's contract stays observable: callers can still pass
    // `messages` through their own prop and ignore the hook output.
    if (!window.electronAPI?.message?.botDirectGetTranscript) return;
    setIsLoading(true);
    setError(null);
    try {
      const result = await getBotDirectTranscriptIPC(sessionId);
      // Defense in depth: even if the server ever returned a non-visible
      // source, drop it here so the renderer surface is source-safe too.
      setMessages(
        result.messages
          .map(ipcMessageToUiMessage)
          .filter((m) => isBotDirectVisible(m.source)),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      setError(null);
      return;
    }
    void refresh();
  }, [sessionId, refresh]);

  // Subscribe to the existing message:new SSE event and merge rows that
  // pass the source filter. The hook stays self-contained — we never
  // touch conversation-store from here.
  useEffect(() => {
    if (!sessionId) return;
    const onMessageNew = window.electronAPI?.onMessageNew;
    if (!onMessageNew) return;
    const unsubscribe = onMessageNew((payload: { sessionId: string; messages: unknown[] }) => {
      if (payload.sessionId !== sessionId) return;
      const incoming: Message[] = [];
      for (const raw of payload.messages) {
        if (!raw || typeof raw !== 'object') continue;
        // The broadcast payload rows are snake_case MessageRow (same shape
        // as the fetch path) — convert before reading camelCase fields,
        // otherwise `createdAt` (and every other mapped field) is
        // undefined and the row later crashes Intl date separators.
        const m = ipcMessageToUiMessage(dbMessageToMessage(raw as DbMessageRow));
        if (!isBotDirectVisible(m.source)) continue;
        incoming.push(m);
      }
      if (incoming.length === 0) return;
      // Plan 491 P1.2: track lastSeq from incoming messages. The IPC wire
      // shape carries `seqIndex`; older `seq` alias kept for safety.
      let maxSeq = lastSeq ?? 0;
      for (const m of incoming) {
        const seq = m.seqIndex ?? m.seq ?? null;
        if (seq != null && seq > maxSeq) {
          maxSeq = seq;
        }
      }
      if (maxSeq !== (lastSeq ?? 0)) {
        setLastSeq(maxSeq);
      }
      setMessages((current) => {
        const seen = new Set(current.map((cm) => cm.id));
        const next = [...current];
        let appended = 0;
        for (const m of incoming) {
          if (m.id && seen.has(m.id)) continue;
          next.push(m);
          appended += 1;
        }
        return appended === 0 ? current : next;
      });
    });
    return unsubscribe;
  }, [sessionId]);

  return { messages, isLoading, error, refresh, lastSeq };
}