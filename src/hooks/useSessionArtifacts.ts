// src/hooks/useSessionArtifacts.ts
// Derives file-change summaries and artifact cards for a single
// session by scanning its tool-call history. Used by the TaskDrawer
// (session-detail panel) to populate the "Environment → changes"
// line and the "Artifacts" section.
//
// Pure derivation — no IPC calls, no DB lookups. Re-runs whenever
// the conversation store emits a new message batch for the active
// thread, so streaming tool results update the panel live.

'use client';

import { useMemo } from 'react';
import { useConversationStore } from '@/stores/conversation-store';
import {
  buildArtifactSummaries,
  buildFileChangeSummaries,
  type ArtifactSummary,
  type FileChangeSummary,
} from '@/lib/tool-file-changes';

export interface UseSessionArtifactsResult {
  fileChanges: FileChangeSummary[];
  artifacts: ArtifactSummary[];
}

/**
 * Extract `ToolAction[]` from a message stream by walking the same
 * `messageToActionItems` pipeline that MessageItem uses. We don't
 * need the full action list — only the tool rows — so we replicate
 * the dispatch here without depending on MessageItem's internal
 * exports. Tool input/result fields we read are documented on
 * `ToolAction` in ToolActionsGroup.tsx.
 */
function collectToolActions(messages: import('@/types').Message[]): import('@/components/chat/ToolActionsGroup').ToolAction[] {
  // The buildFileChangeSummaries pipeline only reads `name`, `input`,
  // `result`, `isError`. We synthesize the minimal shape so the
  // public helper works without dragging in the message-to-actions
  // pairing machinery. Anything more would couple this hook to
  // MessageItem internals.
  const tools: import('@/components/chat/ToolActionsGroup').ToolAction[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const content = message.content;
    if (typeof content === 'string') continue;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type !== 'tool_use') continue;
      const name = typeof block.name === 'string' ? block.name : '';
      if (!name) continue;
      const id = typeof block.id === 'string' ? block.id : `${message.id}:${tools.length}`;
      tools.push({
        id,
        name,
        input: block.input,
        result: typeof block.content === 'string' ? block.content : undefined,
        isError: Boolean(block.is_error),
      });
    }
  }
  return tools;
}

// Module-scoped fallback so the selector always returns the same
// reference for the empty case. Without it, every `?? []` creates
// a fresh array on each render and Zustand (which forwards the
// selector straight to React's useSyncExternalStore) reports
// "The result of getSnapshot should be cached" — triggering the
// Maximum update depth loop we saw in the console.
const EMPTY_MESSAGES: import('@/types').Message[] = [];

export function useSessionArtifacts(sessionId: string | null): UseSessionArtifactsResult {
  const messages = useConversationStore((state) =>
    sessionId ? state.messages[sessionId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES
  );

  return useMemo(() => {
    if (!sessionId) return { fileChanges: [], artifacts: [] };
    const tools = collectToolActions(messages);
    const fileChanges = buildFileChangeSummaries(tools);
    const artifacts = buildArtifactSummaries(fileChanges);
    return { fileChanges, artifacts };
  }, [sessionId, messages]);
}