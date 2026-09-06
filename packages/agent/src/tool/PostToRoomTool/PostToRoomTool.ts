/**
 * PostToRoom Tool Implementation (Plan 478 P2.1)
 *
 * A group member's ONLY voice into a shared room (grok parity: in group
 * member turns only SendMessage text reaches the room — in duya that channel
 * is this dedicated tool, so the 1:1 SendMessage contract stays untouched).
 *
 * Delivery: the authored entry is appended DIRECTLY to the room's transcript
 * session (`room:<roomId>`) with `source: 'group'` and a `metadata.groupPost`
 * payload carrying the member identity. The main process hooks the
 * `message:append` bridge for room sessions: it sees the authored entry,
 * broadcasts the `message:new` SSE to every renderer (free realtime room
 * view), and drives the round-robin orchestrator. The room session itself
 * never runs an LLM.
 *
 * Destination safety: the room id is validated against the groups.toml
 * declaration via `validateRoomTarget` (pattern allowlist + declared-group
 * membership) BEFORE any addressing happens; the tool may only address the
 * validated target it received back.
 *
 * Silence protocol: text equal to "(pass)" (grok isPassContent) is NOT
 * written — it returns a confirmation so the model learns the room saw
 * nothing.
 */

import { randomUUID } from "node:crypto";
import type { Tool, ToolResult, ToolUseContext } from "../../types.js";
import { POST_TO_ROOM_TOOL_NAME } from "./constants.js";
import { isPassContent } from "../../wake/groupTurn.js";
import { listResolvedGroups } from "../../agent-profile/config-groups.js";
import { validateRoomTarget } from "../../session/room-db.js";
import { appendMessages } from "../../session/db.js";
import { parseAgentIdFromBotSession } from "../../agent/dm/bot-session-id.js";
import { readConfigAgents } from "../../agent-profile/config-agents.js";

/** Input schema for PostToRoom tool. */
const POST_TO_ROOM_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    roomId: {
      type: "string",
      description:
        "The id of the shared room to write into (a group chat you are a member of).",
    },
    text: {
      type: "string",
      description:
        'The message content, short and conversational. Send exactly "(pass)" to stay silent this turn.',
    },
  },
  required: ["roomId", "text"],
};

/**
 * Per-turn message budget: at most 2 room messages per member turn (grok
 * GROUP_MAX_MESSAGES_PER_TURN). Keyed by the run constant exactly like the
 * SendToAgent dmSendLimiter — a worker process serves one bot session, so
 * the process-wide budget IS the per-member budget. The window is
 * time-based: a fresh group turn arrives minutes later and resets it.
 */
const TURN_BUDGET_WINDOW_MS = 10 * 60_000;
const MAX_ROOM_MESSAGES_PER_TURN = 2;
const RUN_BUDGET_KEY = "default";
const turnBudgets = new Map<string, { count: number; windowStart: number }>();

/** Test seam — clear budget state. */
export function _resetPostToRoomLimiterForTest(): void {
  turnBudgets.clear();
}

export class PostToRoomTool implements Tool {
  readonly name = POST_TO_ROOM_TOOL_NAME;
  readonly description = `Post a message into a shared room (group chat) you are a member of. Every member of the room sees it at once.

## When to use
- ONLY when you are in a group-chat turn (the prompt is tagged "[Group chat: ...]") — never in your regular 1:1 chat with the user
- When it is your turn in the room discussion and you have something worth adding

## Behavior
- The message is delivered to the room immediately; members reply on their own turns
- Keep messages short and conversational, like texting a teammate
- At most ${MAX_ROOM_MESSAGES_PER_TURN} room messages per turn — do the work first, then deliver the result
- If you have nothing new worth adding, call this with exactly "(pass)" to stay silent

## Restrictions
- You can only write to rooms you are a member of
- Plain text and other tools are private scratch space: the room never sees them
- Never reveal private one-on-one context from your user chats`;

  readonly input_schema: Record<string, unknown> = POST_TO_ROOM_SCHEMA;

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    const roomId = typeof input.roomId === "string" ? input.roomId.trim() : "";
    const text = typeof input.text === "string" ? input.text : "";

    const senderSession =
      context?.options?.sessionId || process.env.SESSION_ID || "unknown";
    const senderAgentId = parseAgentIdFromBotSession(senderSession) ?? senderSession;

    if (!roomId) {
      return { id: randomUUID(), name: this.name, result: "Error: roomId is required.", error: true };
    }
    if (!text.trim()) {
      return { id: randomUUID(), name: this.name, result: "Error: text is required.", error: true };
    }

    // Silence protocol — "(pass)" writes nothing; the orchestrator reads it
    // as "this member stays silent this round".
    if (isPassContent(text)) {
      return {
        id: randomUUID(),
        name: this.name,
        result: "You passed — the room saw no message from you this turn.",
      };
    }

    // Existence + membership validation (grok: "You can only write to a group
    // you're a member of."). The declaration lookup doubles as the
    // destination allowlist.
    let groupName = roomId;
    let target: ReturnType<typeof validateRoomTarget> = null;
    try {
      const groups = await listResolvedGroups();
      const group = groups[roomId];
      if (!group) {
        return {
          id: randomUUID(),
          name: this.name,
          result: `Error: Room "${roomId}" does not exist.`,
          error: true,
        };
      }
      groupName = group.name;
      if (!group.memberIds.includes(senderAgentId)) {
        return {
          id: randomUUID(),
          name: this.name,
          result: "Error: You can only write to a room you are a member of.",
          error: false,
        };
      }
      // Allowlisted destination — derived only from the validated id.
      target = validateRoomTarget(roomId, groups);
      if (!target) {
        return {
          id: randomUUID(),
          name: this.name,
          result: "Error: Invalid room id.",
          error: true,
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { id: randomUUID(), name: this.name, result: `Failed to write: ${message}`, error: true };
    }

    // Per-turn message budget (constant run key — see SendToAgent's
    // dmSendLimiter for the same pattern).
    const now = Date.now();
    const budget = turnBudgets.get(RUN_BUDGET_KEY);
    if (!budget || now - budget.windowStart > TURN_BUDGET_WINDOW_MS) {
      turnBudgets.set(RUN_BUDGET_KEY, { count: 0, windowStart: now });
    }
    const current = turnBudgets.get(RUN_BUDGET_KEY)!;
    if (current.count >= MAX_ROOM_MESSAGES_PER_TURN) {
      return {
        id: randomUUID(),
        name: this.name,
        result: `Error: Room message limit reached (${MAX_ROOM_MESSAGES_PER_TURN} per turn). Your turn is over — other members now speak.`,
        error: false,
      };
    }

    const clientMsgId = randomUUID();
    try {
      const agents = await readConfigAgents();
      const memberName = agents[senderAgentId]?.name || senderAgentId;

      // IMPORTANT: must await. In IPC mode appendMessages returns a Promise —
      // without await the try/catch never sees DB failures and the tool
      // reports success even when the write failed.
      await appendMessages(target.sessionId, [
        {
          id: randomUUID(),
          role: "assistant",
          content: text,
          status: "complete",
          msg_type: "text",
          source: "group",
          timestamp: Date.now(),
          metadata: {
            source: "group",
            groupPost: {
              roomId,
              roomName: groupName,
              memberId: senderAgentId,
              memberName,
              text,
              clientMsgId,
            },
          },
        },
      ]);
      current.count += 1;

      return {
        id: randomUUID(),
        name: this.name,
        result: `Sent to ${groupName}. Your message is visible to every member.`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { id: randomUUID(), name: this.name, result: `Failed to write: ${message}`, error: true };
    }
  }
}

export const postToRoomTool = new PostToRoomTool();
