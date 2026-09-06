"use client";

/**
 * useRoomTranscript — Plan 478 P3.1
 *
 * The group-room chat surface (GroupRoomChatView) shows only room-visible
 * rows: the user's posts (`user`), member speech via post_to_room (`group`)
 * and room lifecycle notices (`group_system`). Projection mirrors
 * useBotDirectTranscript:
 *
 *   1. On mount, fetch the room transcript via IPC `room:getTranscript`
 *      (the server applies the source filter — electron/ipc/group-handlers.ts).
 *   2. Subscribe to the `message:new` SSE event and merge rows whose source
 *      passes the room filter — bot posts arrive exactly this way (the
 *      worker's post_to_room append is broadcast from the message:append
 *      bridge), so member speech appears in realtime without polling.
 *   3. Cleans up on unmount / room change.
 *
 * Self-contained like useBotDirectTranscript: the workspace conversation
 * store never learns about room sessions.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { dbMessageToMessage, type DbMessage as DbMessageRow, type Message as IpcMessage } from "@/lib/ipc-client";
import type { Message } from "@/types/message";

const ROOM_VISIBLE_SOURCES: ReadonlySet<string> = new Set([
  "user",
  "group",
  "group_system",
]);

function isRoomVisible(source: string | null | undefined): boolean {
  if (!source) return false;
  return ROOM_VISIBLE_SOURCES.has(source);
}

/** IPC Message (camelCase) → UI Message shape (same bridge as bot-direct). */
function ipcMessageToUiMessage(m: IpcMessage): Message {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    displayContent: m.displayContent,
    name: m.name ?? undefined,
    tool_call_id: m.toolCallId ?? undefined,
    timestamp: m.createdAt,
    tokenUsage: null,
    msgType: (m.msgType || undefined) as Message["msgType"],
    status: m.status ?? undefined,
    seqIndex: m.seqIndex ?? undefined,
    seq: m.seqIndex ?? undefined,
    source: m.source ?? null,
    sendMessageMeta: m.sendMessageMeta ?? null,
    agentDmMeta: m.agentDmMeta ?? null,
    groupPostMeta: m.groupPostMeta ?? null,
  };
}

export interface UseRoomTranscriptResult {
  messages: Message[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useRoomTranscript(sessionId: string | null): UseRoomTranscriptResult {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setMessages([]);
      return;
    }
    if (!window.electronAPI?.room?.getTranscript) return;
    setIsLoading(true);
    setError(null);
    try {
      const rows = (await window.electronAPI.room.getTranscript(sessionId)) as unknown[];
      const mapped: Message[] = [];
      for (const raw of rows) {
        if (!raw || typeof raw !== "object") continue;
        const m = ipcMessageToUiMessage(dbMessageToMessage(raw as DbMessageRow));
        if (!isRoomVisible(m.source)) continue;
        mapped.push(m);
      }
      setMessages(mapped);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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

  // Realtime merge: the room transcript session is broadcast through the
  // same message:new SSE event as every other session.
  useEffect(() => {
    if (!sessionId) return;
    const onMessageNew = window.electronAPI?.onMessageNew;
    if (!onMessageNew) return;
    const unsubscribe = onMessageNew((payload: { sessionId: string; messages: unknown[] }) => {
      if (payload.sessionId !== sessionId) return;
      const incoming: Message[] = [];
      for (const raw of payload.messages) {
        if (!raw || typeof raw !== "object") continue;
        const m = ipcMessageToUiMessage(dbMessageToMessage(raw as DbMessageRow));
        if (!isRoomVisible(m.source)) continue;
        incoming.push(m);
      }
      if (incoming.length === 0) return;
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

  return { messages, isLoading, error, refresh };
}
