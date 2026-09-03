/**
 * SendToAgent Tool Implementation (Plan 477 P1.2)
 *
 * Asynchronous agent-to-agent DM tool. The sending agent calls this to deliver
 * a message to another agent. The message is written to the agent_mailbox table
 * (kind='agent_dm') and the 476 Wake Bus handles waking the target agent.
 *
 * Key differences from MessageSessionTool:
 * - Fire-and-forget: does not wait for a reply
 * - Uses mailbox (not interagent:invoke request-response)
 * - Async delivery via Wake Bus
 */

import { randomUUID } from "node:crypto";
import type { Tool, ToolResult, ToolUseContext } from "../../types.js";
import { SEND_TO_AGENT_TOOL_NAME } from "./constants.js";
import {
  AgentDmEnvelope,
  ImageRef,
  clampAgentMessage,
  encodeEnvelope,
  prepareEnvelopeForSend,
} from "../../agent/dm/index.js";
import { dmCycleDetector, dmSendLimiter } from "../../agent/dm/dm-cycle-detector.js";
import { mailboxSend } from "../../session/db.js";
import { readConfigAgents } from "../../agent-profile/config-agents.js";

/** Input schema for SendToAgent tool. */
const SEND_TO_AGENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    toAgentId: {
      type: "string",
      description:
        "The id of the target agent to message. Use SessionSearch to discover agent ids first.",
    },
    text: {
      type: "string",
      description:
        "The message content to send. Will be truncated to 8000 characters if longer.",
    },
    images: {
      type: "array",
      description:
        "Optional image attachments (file:// or https:// URLs). Only supported for 1:1 DMs, not group messages.",
      items: {
        type: "object",
        properties: {
          url: { type: "string" },
          alt: { type: "string" },
        },
        required: ["url"],
      },
    },
    priority: {
      type: "boolean",
      default: false,
      description:
        "If true, this is a priority message that interrupts the recipient's current non-user work.",
    },
  },
  required: ["toAgentId", "text"],
};

export class SendToAgentTool implements Tool {
  readonly name = SEND_TO_AGENT_TOOL_NAME;
  readonly description = `Send a message to another agent and return immediately without waiting for a reply.

## When to use
- When you need to communicate with another of the user's agents asynchronously
- When you want to delegate a subtask to another agent
- When you have information another agent needs but don't need an immediate answer

## Behavior
- DELIVERY IS ASYNCHRONOUS: the tool returns immediately after the message is queued
- The target agent is woken up and receives the message on a future turn
- If the target agent replies, it arrives as a separate incoming message that wakes you
- Do NOT wait or poll for a reply — send and carry on

## Priority messages
- Use priority=true sparingly; it interrupts the recipient's non-user work
- Only use for urgent items that genuinely need immediate attention

## Restrictions
- You cannot message yourself
- You cannot message agents that no longer exist
- Group messages do not support images or priority`;

  readonly input_schema: Record<string, unknown> = SEND_TO_AGENT_SCHEMA;

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
    const toAgentId = input.toAgentId as string;
    const text = (input.text as string) || "";
    const images = (input.images as ImageRef[] | undefined) ?? [];
    const priority = (input.priority as boolean) ?? false;

    // Get sender identity from context
    const fromAgentId = context?.options?.sessionId || process.env.SESSION_ID || "unknown";
    const fromAgentName = this.resolveAgentName(fromAgentId);

    // === Validation ===
    if (!toAgentId) {
      return {
        id: randomUUID(),
        name: this.name,
        result: "Error: toAgentId is required.",
        error: true,
      };
    }

    if (!text && images.length === 0) {
      return {
        id: randomUUID(),
        name: this.name,
        result: "Error: text or images must be provided.",
        error: true,
      };
    }

    if (toAgentId === fromAgentId) {
      return {
        id: randomUUID(),
        name: this.name,
        result: "Error: An agent cannot message itself. Use a different toAgentId.",
        error: false,
      };
    }

    // === P3.2: Validate target agent exists in botRoster ===
    const agents = await readConfigAgents();
    const targetConfig = agents[toAgentId];
    const targetName = targetConfig?.name ?? `Agent ${toAgentId}`;

    if (!targetConfig) {
      // Target agent not found in roster - show available agents
      const availableAgents = Object.entries(agents)
        .filter(([id]) => id !== fromAgentId)
        .map(([id, cfg]) => `${id}${cfg.name ? ` (${cfg.name})` : ""}`)
        .join(", ");
      const msg = `Error: Agent "${toAgentId}" not found. Available agents: ${availableAgents || "none configured"}.`;
      return { id: randomUUID(), name: this.name, result: msg, error: true };
    }

    // === Cycle detection: prevent A↔B same-pair cycles ===
    if (dmCycleDetector.hasEdge(toAgentId, fromAgentId)) {
      return {
        id: randomUUID(),
        name: this.name,
        result: `Error: Cannot send to ${targetName}. They recently sent a message to you, and a round-trip exchange would create a ping-pong loop. Wait for your message to be handled before sending another.`,
        error: false,
      };
    }

    // === Send limit check: prevent flooding (>5 per run) ===
    // Note: runId from context is not available; using a process-wide default
    // TODO: wire proper runId from execution context when available
    if (!dmSendLimiter.canSend("default")) {
      return {
        id: randomUUID(),
        name: this.name,
        result: `Error: Send limit reached (${dmSendLimiter.max} messages per run). Do not send more DMs this turn — wait for replies to arrive first.`,
        error: false,
      };
    }

    // === Build envelope ===
    const clientMsgId = randomUUID();
    const timestampMs = Date.now();
    const clampedText = clampAgentMessage(text);

    const envelope: AgentDmEnvelope = {
      from: { id: fromAgentId, name: fromAgentName },
      to: { id: toAgentId, name: targetName },
      text: clampedText,
      images: images.length > 0 ? images : undefined,
      priority: priority || undefined,
      timestampMs,
      clientMsgId,
    };

    // === Prepare and encode ===
    const preparedEnvelope = prepareEnvelopeForSend(envelope);
    const encodedContent = encodeEnvelope(preparedEnvelope);

    // === Send to mailbox (kind='agent_dm') ===
    try {
      const row = mailboxSend({
        id: randomUUID(),
        sessionId: toAgentId, // Target agent's session (resolver handles this)
        submittedDuringRunId: "", // DM is async, no run context
        content: encodedContent,
        kind: "agent_dm",
        source: fromAgentId,
        clientMsgId,
      });

      // === Record in cycle detector and send limiter ===
      dmCycleDetector.addEdge(fromAgentId, toAgentId);
      dmSendLimiter.recordSend("default");

      // === Build response ===
      const targetName = `Agent ${toAgentId}`;
      if (priority) {
        return {
          id: randomUUID(),
          name: this.name,
          result: `Sent to ${targetName} as a priority message — it will interrupt their current non-user work and wake them now. This is asynchronous — if they reply, it'll arrive later as a new message that wakes you.`,
        };
      }
      return {
        id: randomUUID(),
        name: this.name,
        result: `Sent to ${targetName}. This is asynchronous — if they reply, it'll arrive later as a new message that wakes you.`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        id: randomUUID(),
        name: this.name,
        result: `Failed to send message: ${message}`,
        error: true,
      };
    }
  }

  /**
   * Resolve agent name from agent id.
   * Falls back to a placeholder; the roster lookup would provide the real name.
   */
  private resolveAgentName(agentId: string): string {
    // TODO: Look up agent name from roster via IPC
    // For now, use a stable default based on the agent id
    if (agentId.startsWith("bot:")) {
      return agentId.slice(4);
    }
    return `Agent ${agentId.slice(0, 8)}`;
  }
}

export const sendToAgentTool = new SendToAgentTool();
