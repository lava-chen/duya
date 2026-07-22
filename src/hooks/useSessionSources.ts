// src/hooks/useSessionSources.ts
// Aggregates every attachment ever sent or referenced in a session
// and groups them by kind for the "Sources" section of the
// TaskDrawer / session-detail panel.
//
// Bucketing rule:
//   - 'file' / 'image'         → userAttachments (file-system uploads)
//   - 'browser-ref'            → browserUrls   (visited web references)
//   - everything else          → others        (paste / terminal / file-tree)
//
// Attachments are deduplicated within each bucket by a stable key
// (id, or url for browser refs). Order is the order they first
// appeared in the message history, oldest first.

'use client';

import { useMemo } from 'react';
import { useConversationStore } from '@/stores/conversation-store';
import type { FileAttachment, Message } from '@/types/message';

// Module-scoped fallback so the selector returns the same reference
// for the empty case. See useSessionArtifacts for the full rationale
// (Zustand passes the selector straight to useSyncExternalStore;
// a fresh `[]` each render triggers the "getSnapshot should be
// cached" infinite-loop warning).
const EMPTY_MESSAGES: Message[] = [];

export interface UseSessionSourcesResult {
  userAttachments: FileAttachment[];
  browserUrls: FileAttachment[];
  others: FileAttachment[];
}

function attachKind(att: FileAttachment): FileAttachment['kind'] {
  // Older persisted rows may omit `kind`; fall back to 'file' so
  // they still show up under user uploads.
  return att.kind ?? 'file';
}

function seenKey(att: FileAttachment): string {
  if (att.kind === 'browser-ref') {
    const meta = att.metadata as { url?: string } | undefined;
    return meta?.url ?? att.id;
  }
  return att.id;
}

export function useSessionSources(sessionId: string | null): UseSessionSourcesResult {
  const messages = useConversationStore((state) =>
    sessionId ? state.messages[sessionId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES
  );

  return useMemo(() => {
    const userAttachments: FileAttachment[] = [];
    const browserUrls: FileAttachment[] = [];
    const others: FileAttachment[] = [];
    const seenUser = new Set<string>();
    const seenBrowser = new Set<string>();
    const seenOther = new Set<string>();

    if (!sessionId) {
      return { userAttachments, browserUrls, others };
    }

    for (const message of messages) {
      const atts = message.attachments;
      if (!atts || atts.length === 0) continue;

      for (const att of atts) {
        const kind = attachKind(att);
        if (kind === 'file' || kind === 'image') {
          if (seenUser.has(att.id)) continue;
          seenUser.add(att.id);
          userAttachments.push(att);
        } else if (kind === 'browser-ref') {
          const key = seenKey(att);
          if (seenBrowser.has(key)) continue;
          seenBrowser.add(key);
          browserUrls.push(att);
        } else {
          if (seenOther.has(att.id)) continue;
          seenOther.add(att.id);
          others.push(att);
        }
      }
    }

    return { userAttachments, browserUrls, others };
  }, [sessionId, messages]);
}