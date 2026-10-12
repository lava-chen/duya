import { createHash } from 'node:crypto';
import {
  ingestMessage,
  type DurableTimelineEntry,
  type LegacyPersistedMessage,
  type MessageEntry,
  type RebaseEvent,
} from '@duya/agent-protocol';
import type { CliHostSession } from './host-session.js';

export interface CliTranscriptPersistence {
  (messages: readonly LegacyPersistedMessage[]): Promise<void>;
  /** Mark a loaded transcript as already persisted for the active session. */
  setBaseline(messages: readonly LegacyPersistedMessage[]): void;
}

/** Convert CLI message snapshots into idempotent Host timeline writes. */
export function createCliTranscriptPersistence(
  session: Pick<CliHostSession, 'id' | 'appendTimeline'>,
  options: { readonly excludeIdSuffix?: string } = {},
): CliTranscriptPersistence {
  const persistenceTurns = new Map<string, number>();
  const previousSnapshotIds = new Map<string, Set<string>>();

  const persist: CliTranscriptPersistence = async (messages) => {
    const sessionId = session.id;
    const previousIds = previousSnapshotIds.get(sessionId) ?? new Set<string>();
    const entries: MessageEntry[] = messages
      .filter((message) => !options.excludeIdSuffix || !(message.id ?? '').endsWith(options.excludeIdSuffix))
      .map((message, index) => {
        const id = message.id || `cli:${sessionId}:message:${index}`;
        const timestamp = message.timestamp ?? 0;
        const legacyMessage = { ...message, id, timestamp } as LegacyPersistedMessage;
        const source: MessageEntry['source'] = message.role === 'user'
          ? 'user'
          : message.role === 'tool'
            ? 'tool_use'
            : message.role === 'system'
              ? 'system'
              : 'scratchpad';
        return {
          type: 'message',
          id,
          parentId: null,
          createdAt: timestamp,
          message: ingestMessage(legacyMessage, { index }),
          source,
        };
      });

    const currentIds = new Set(entries.map((entry) => entry.id));
    const removedPriorMessage = [...previousIds].some((id) => !currentIds.has(id));
    const hasCompactionSummary = messages.some((message) => message.isCompactSummary === true);
    const turn = (persistenceTurns.get(sessionId) ?? 0) + 1;
    persistenceTurns.set(sessionId, turn);
    const turnId = `cli:${sessionId}:turn:${turn}`;
    let appendEntries: DurableTimelineEntry[];

    if (entries.length > 0 && removedPriorMessage && hasCompactionSummary) {
      const fingerprint = createHash('sha256')
        .update(entries.map((entry) => entry.id).join('\0'))
        .digest('hex')
        .slice(0, 20);
      const rebase: RebaseEvent = {
        type: 'rebase',
        id: `cli-rebase:${sessionId}:${fingerprint}`,
        turnId,
        supersededUpToSeq: null,
        reason: 'compaction',
        newMessages: entries,
        createdAt: entries.reduce((latest, entry) => Math.max(latest, entry.createdAt), 0),
      };
      appendEntries = [rebase];
    } else {
      appendEntries = entries.filter((entry) => !previousIds.has(entry.id));
    }

    await session.appendTimeline(appendEntries, turnId);
    previousSnapshotIds.set(sessionId, currentIds);
  };

  persist.setBaseline = (messages) => {
    const sessionId = session.id;
    const ids = messages
      .filter((message) => !options.excludeIdSuffix || !(message.id ?? '').endsWith(options.excludeIdSuffix))
      .map((message, index) => message.id || `cli:${sessionId}:message:${index}`);
    previousSnapshotIds.set(sessionId, new Set(ids));
  };

  return persist;
}

export async function updateCliSessionTitle(
  session: Pick<CliHostSession, 'updateTitle'>,
  messages: readonly LegacyPersistedMessage[],
): Promise<void> {
  const firstUserMessage = messages.find((message) => message.role === 'user');
  if (!firstUserMessage) return;
  const title = typeof firstUserMessage.content === 'string'
    ? firstUserMessage.content.slice(0, 50)
    : 'Chat';
  if (title.trim()) await session.updateTitle(title);
}
