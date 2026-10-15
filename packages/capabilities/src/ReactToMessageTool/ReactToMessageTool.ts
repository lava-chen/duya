import { randomUUID } from 'node:crypto';
import { BaseTool } from '../BaseTool.js';
import type { ToolResult, ToolUseContext } from '../contracts/tool.js';
import { MAX_EMOJI_CHARS, REACT_TO_MESSAGE_TOOL_NAME } from './constants.js';
import type { ReactToMessagePort, ReactToMessageTranscriptRow } from './ports.js';
import type { ReactToMessageErrorCode } from './constants.js';

export interface ReactToMessageInput {
  messageId: string;
  emoji: string;
}

export interface ReactionDescriptor {
  /** Target message id (the bubble the pill renders on). */
  targetId: string;
  emoji: string;
  /** Reacting identity: the bot's agentProfileId, or 'me' fallback. */
  by: string;
}

export type ResolvedReaction =
  | { ok: true; messageId: string; emoji: string }
  | { ok: false; code: ReactToMessageErrorCode; message: string };

export function resolveReactToMessage(input: unknown): ResolvedReaction {
  if (!input || typeof input !== 'object') {
    return { ok: false, code: 'INVALID_INPUT', message: 'ReactToMessage input must be an object.' };
  }
  const raw = input as Record<string, unknown>;
  const messageId = typeof raw.messageId === 'string' ? raw.messageId.trim() : '';
  if (!messageId || messageId.length > 128) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: 'messageId is required (the id of the message to react to).',
    };
  }
  const emoji = typeof raw.emoji === 'string' ? raw.emoji.trim().slice(0, MAX_EMOJI_CHARS) : '';
  if (!emoji) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: 'emoji is required — a single common emoji, e.g. 👍 ❤️ 😂 🎉.',
    };
  }
  return { ok: true, messageId, emoji };
}

export class ReactToMessageTool extends BaseTool {
  readonly name = REACT_TO_MESSAGE_TOOL_NAME;
  readonly description = `React to a message in this chat with a single emoji tapback (like an iMessage reaction), shown as a small pill on that message. Use this VERY sparingly, only when a reaction is the genuinely natural, human response and a reply would be overkill: they said something funny, shared good news, or a quick 👍 fits better than a sentence. It is NOT a substitute for a real reply when you were asked something, and never react just to seem friendly. Only react to messages visible in this chat (pass their message id — user messages and your own sends both qualify). It toggles: reacting the same emoji to the same message again removes your reaction, which is how you take one back. Fire-and-forget: it returns nothing to act on. Mirror the user — if they don't use emoji, basically never do this.`;
  readonly input_schema = {
    type: 'object',
    properties: {
      messageId: {
        type: 'string',
        description: 'The id of the message to react to — the (id: ...) shown when the message was sent, or the target of this turn. Only messages in this chat.',
      },
      emoji: {
        type: 'string',
        description: 'A single common emoji to react with, e.g. 👍 ❤️ 😂 🎉.',
      },
    },
    required: ['messageId', 'emoji'],
  };

  constructor(private readonly port: ReactToMessagePort) {
    super();
  }

  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    const fail = (code: ReactToMessageErrorCode, message: string): ToolResult => ({
      id: randomUUID(),
      name: this.name,
      result: JSON.stringify({ success: false, error: { code, message } }),
      error: true,
    });

    const resolved = resolveReactToMessage(input);
    if (!resolved.ok) {
      return fail(resolved.code, resolved.message);
    }

    const { sessionId, actorId } = this.port.resolveInvocationContext(context);
    if (!sessionId) {
      return fail('NO_SESSION', 'No active session. ReactToMessage requires an active conversation.');
    }

    try {
      const rows = await this.port.getTranscript(sessionId);
      const target = rows.find((row) => row && row.id === resolved.messageId);
      if (!target) {
        return fail('NOT_FOUND', `No message with id '${resolved.messageId}' exists in this chat. React with the id shown on the message.`);
      }

      const targetSource = (target.source ?? '').toString();
      const targetRole = (target.role ?? '').toString();
      const reactable =
        targetSource === 'user' ||
        targetSource === 'send_message' ||
        // Legacy rows predating the source classifier: role is authoritative.
        (targetSource === '' && (targetRole === 'user' || targetRole === 'assistant'));
      if (!reactable) {
        return fail('NOT_REACTABLE', 'Only messages visible in the chat (user messages and your sends) can be reacted to.');
      }

      const by = actorId || 'me';
      const existing = collectReactions(rows, resolved.messageId, by);
      const isRemoving = existing.includes(resolved.emoji);
      const next = isRemoving
        ? existing.filter((emoji) => emoji !== resolved.emoji)
        : [...existing, resolved.emoji];

      await this.port.appendReaction({
        sessionId,
        targetId: resolved.messageId,
        emoji: resolved.emoji,
        by,
        set: next,
      });

      if (isRemoving) {
        return {
          id: randomUUID(),
          name: this.name,
          result: `Removed your ${resolved.emoji} reaction on (id: ${resolved.messageId}).`,
        };
      }

      return {
        id: randomUUID(),
        name: this.name,
        result: `Reacted ${resolved.emoji} on (id: ${resolved.messageId}). (Reactions toggle: react the same emoji again to take it back.)`,
      };
    } catch (error) {
      return fail('BRIDGE_ERROR', error instanceof Error ? error.message : String(error));
    }
  }
}

/** Fold newest reaction snapshots by (targetId, by), retaining legacy rows without snapshots. */
export function collectReactions(rows: readonly ReactToMessageTranscriptRow[], targetId: string, by: string): string[] {
  let current: string[] = [];
  for (const row of rows) {
    const reaction = row?.metadata?.reaction;
    if (!reaction || reaction.targetId !== targetId || reaction.by !== by) continue;
    if (Array.isArray(reaction.set)) {
      current = reaction.set.filter((emoji): emoji is string => typeof emoji === 'string');
    } else if (typeof reaction.emoji === 'string' && reaction.emoji) {
      current = current.includes(reaction.emoji) ? current : [...current, reaction.emoji];
    }
  }
  return current;
}
