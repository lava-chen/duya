/**
 * ReactToMessageTool — Plan 490 P1 (grok sand-reaction-tool parity).
 *
 * An emoji tapback on a message the bot can see in its chat — like an
 * iMessage reaction, shown as a small pill on the target bubble. grok
 * semantics carried over:
 *   - ONLY user-visible messages are reactable (grok restricts to the
 *     user's own messages; duya allows 'user' and 'send_message' rows —
 *     the user's words and the bot's own sends are both visible bubbles
 *     in the bot-direct view).
 *   - Toggling: reacting the same emoji to the same message again removes
 *     the reaction — that is how the model takes one back.
 *   - Fire-and-forget: it never ends the turn's obligations and returns
 *     a short confirmation, not data to act on.
 *
 * Storage: a dedicated MessageSource='reaction' row in the normal message
 * pipeline (messageDb.append → MessageLog rollout + index). The row's
 * metadata.reaction = { targetId, emoji, by } carries everything the
 * renderer needs to group pills onto target bubbles. Toggle resolution
 * scans the session's existing reaction rows via message:getBySession and
 * re-appends the reduced set — the pipeline is append-only (INSERT OR
 * IGNORE idempotency, no per-row delete), matching how grok rewrites the
 * transcript entry's reactions array.
 *
 * Exposure: registered exposeMode 'always' (grok SAND_FORCED_STATIC
 * parity — see turn-toolset.ts), deliberately NOT in BOT_TOOLSET: the
 * exact-name allowlist promotion would hide it from non-bot profiles that
 * list explicit tools, while 'always' matches grok's unconditional
 * surface. A restrictive profile's explicit allowlist still wins (duya's
 * hard security boundary).
 */

import { randomUUID } from 'node:crypto';
import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { PermissionCheckResult, ToolContext } from '../types.js';
import { messageDb } from '../../ipc/db-client.js';
import {
  MAX_EMOJI_CHARS,
  REACT_TO_MESSAGE_TOOL_NAME,
  type ReactToMessageErrorCode,
} from './constants.js';

// ============================================================
// Resolution — shared by checkPermissions and execute
// ============================================================

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

// ============================================================
// Tool
// ============================================================

interface ReactionRowView {
  id: string;
  role?: string;
  msg_type?: string;
  source?: string | null;
  metadata?: { reaction?: { targetId?: string; emoji?: string; by?: string } } | null;
  send_message_meta?: string | null;
}

export class ReactToMessageTool implements Tool {
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

  toTool(): Tool {
    return { name: this.name, description: this.description, input_schema: this.input_schema };
  }

  // ----------------------------------------------------------
  // Permissions — self-scoped expression, always pre-approved
  // (grok: the reaction is the turn; no confirmation stage exists).
  // ----------------------------------------------------------
  checkPermissions(_input: unknown, _context: ToolContext): PermissionCheckResult {
    return { allowed: true, reason: 'Emoji tapback (self-scoped, pre-approved).' };
  }

  // ----------------------------------------------------------
  // Execution
  // ----------------------------------------------------------
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

    const sessionId = context?.options?.sessionId;
    if (!sessionId) {
      return fail('NO_SESSION', 'No active session. ReactToMessage requires an active conversation.');
    }

    try {
      // ── Load the session's message rows (single source of truth) ──
      const raw = await messageDb.getBySession(sessionId);
      const rows = Array.isArray(raw) ? (raw as ReactionRowView[]) : [];

      // Target must exist and be reactable (user-visible bubble rows).
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

      const by = context?.options?.agentProfileId || 'me';

      // ── Toggle: rebuild the reaction set for (target, by, emoji) ──
      const existing = collectReactions(rows, resolved.messageId, by);
      const isRemoving = existing.includes(resolved.emoji);
      const next = isRemoving
        ? existing.filter((e) => e !== resolved.emoji)
        : [...existing, resolved.emoji];

      if (isRemoving) {
        // Append-only pipeline: the removal is recorded as a fresh row
        // carrying the reduced set; groupers fold rows by (targetId, by)
        // newest-first, so the reduced set wins without rewrites.
        await appendReactionRow(sessionId, resolved.messageId, resolved.emoji, by, next);
        return {
          id: randomUUID(),
          name: this.name,
          result: `Removed your ${resolved.emoji} reaction on (id: ${resolved.messageId}).`,
        };
      }

      await appendReactionRow(sessionId, resolved.messageId, resolved.emoji, by, next);
      return {
        id: randomUUID(),
        name: this.name,
        result: `Reacted ${resolved.emoji} on (id: ${resolved.messageId}). (Reactions toggle: react the same emoji again to take it back.)`,
      };
    } catch (err) {
      return fail('BRIDGE_ERROR', err instanceof Error ? err.message : String(err));
    }
  }
}

/**
 * Collect the emoji the given identity currently has on a target, folding
 * the newest reaction row per (targetId, by) last-wins. Only rows that
 * carry metadata.reaction count.
 */
export function collectReactions(rows: ReactionRowView[], targetId: string, by: string): string[] {
  let current: string[] = [];
  for (const row of rows) {
    const reaction = row?.metadata?.reaction;
    if (!reaction || reaction.targetId !== targetId || reaction.by !== by) continue;
    // The row's emoji is the newly added one; set/removed is the snapshot.
    if (Array.isArray((reaction as { set?: unknown }).set)) {
      const set = (reaction as unknown as { set: unknown[] }).set
        .filter((e): e is string => typeof e === 'string');
      current = set;
    } else if (typeof reaction.emoji === 'string' && reaction.emoji) {
      current = current.includes(reaction.emoji) ? current : [...current, reaction.emoji];
    }
  }
  return current;
}

/** Append one reaction row through the normal message pipeline. */
async function appendReactionRow(
  sessionId: string,
  targetId: string,
  emoji: string,
  by: string,
  set: string[],
): Promise<void> {
  const descriptor: ReactionDescriptor & { set: string[] } = {
    targetId,
    emoji,
    by,
    set,
  };
  await messageDb.append(sessionId, [
    {
      id: randomUUID(),
      session_id: sessionId,
      role: 'assistant',
      // No standalone bubble content; the renderer reads the descriptor.
      content: '',
      status: 'complete',
      msg_type: 'reaction',
      // Plan 489 P0.1: explicit source wins the IPC inference, and the
      // adapter also mirrors it into metadata.source.
      source: 'reaction',
      metadata: {
        source: 'reaction',
        reaction: descriptor,
      },
      created_at: Date.now(),
    },
  ]);
}

export const reactToMessageTool = new ReactToMessageTool();
