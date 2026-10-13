/**
 * Compatibility adapter for the legacy Agent import path.
 *
 * Tool behavior lives in @duya/capabilities. This adapter only binds the
 * Agent worker's transcript IPC and invocation context to the narrow port.
 */
import { randomUUID } from 'node:crypto';
import {
  ReactToMessageTool as CapabilityReactToMessageTool,
  type AppendReactionInput,
  type PermissionCheckResult,
  type ReactToMessagePort,
  type ReactToMessageTranscriptRow,
  type ToolContext,
} from '@duya/capabilities';
import { messageDb } from '../../ipc/db-client.js';

export {
  collectReactions,
  resolveReactToMessage,
  type ReactToMessageInput,
  type ReactionDescriptor,
  type ResolvedReaction,
} from '@duya/capabilities';

const agentReactToMessagePort: ReactToMessagePort = {
  resolveInvocationContext(context) {
    if (!context || typeof context !== 'object') return {};
    const options = (context as { options?: unknown }).options;
    if (!options || typeof options !== 'object') return {};

    const invocation = options as Record<string, unknown>;
    return {
      sessionId: typeof invocation.sessionId === 'string' ? invocation.sessionId : undefined,
      actorId: typeof invocation.agentProfileId === 'string' ? invocation.agentProfileId : undefined,
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
        // No standalone bubble content; the renderer reads the descriptor.
        content: '',
        status: 'complete',
        msg_type: 'reaction',
        source: 'reaction',
        metadata: {
          source: 'reaction',
          reaction,
        },
        created_at: Date.now(),
      },
    ]);
  },
};

/** Legacy constructor shape stays no-argument for existing registrations. */
export class ReactToMessageTool extends CapabilityReactToMessageTool {
  constructor(port: ReactToMessagePort = agentReactToMessagePort) {
    super(port);
  }

  /** Preserve the legacy Agent gate; authorization policy stays outside Capabilities. */
  checkPermissions(_input: unknown, _context: ToolContext): PermissionCheckResult {
    return { allowed: true, reason: 'Emoji tapback (self-scoped, pre-approved).' };
  }
}

/** Shared Agent singleton used by builtin and bot-builtin registries. */
export const reactToMessageTool = new ReactToMessageTool();
