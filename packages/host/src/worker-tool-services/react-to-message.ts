import { randomUUID } from 'node:crypto';
import type {
  AppendReactionInput,
  ReactToMessagePort,
  ReactToMessageTranscriptRow,
} from '@duya/capabilities/react-to-message-tool';
import { messageDb } from '../worker-db-client.js';

/** Bind reactions to the canonical worker transcript IPC routes. */
export function createWorkerReactToMessagePort(): ReactToMessagePort {
  return {
    resolveInvocationContext(context) {
      if (!context || typeof context !== 'object') return {};
      const options = (context as { options?: unknown }).options;
      if (!options || typeof options !== 'object') return {};
      const invocation = options as Record<string, unknown>;
      return {
        ...(typeof invocation.sessionId === 'string' ? { sessionId: invocation.sessionId } : {}),
        ...(typeof invocation.agentProfileId === 'string' ? { actorId: invocation.agentProfileId } : {}),
      };
    },
    async getTranscript(sessionId) {
      const rows: unknown = await messageDb.getBySession(sessionId);
      return Array.isArray(rows) ? rows as ReactToMessageTranscriptRow[] : [];
    },
    async appendReaction(input: AppendReactionInput) {
      const reaction = {
        targetId: input.targetId,
        emoji: input.emoji,
        by: input.by,
        set: input.set,
      };
      await messageDb.append(input.sessionId, [
        {
          id: randomUUID(),
          session_id: input.sessionId,
          role: 'assistant',
          content: '',
          status: 'complete',
          msg_type: 'reaction',
          source: 'reaction',
          metadata: { source: 'reaction', reaction },
          created_at: Date.now(),
        },
      ]);
    },
  };
}
