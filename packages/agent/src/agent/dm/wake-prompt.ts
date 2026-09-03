/**
 * Agent-to-Agent DM Wake Prompt Builder (Plan 477 P1.3)
 *
 * Builds the wake prompt that is injected when a receiving agent is revived
 * with a pending agent_dm message.
 */

import {
  AgentDmEnvelope,
  AgentAddress,
  AGENT_INBOUND_WAKE_CUE,
} from "./types.js";

import { clampAgentMessage } from "./envelope.js";

/**
 * Build the wake prompt injected when an agent receives an inbound DM.
 *
 * This is the "cue" that marks the incoming message as coming from another
 * agent, not the user. The agent uses this to understand the context and
 * decide whether to reply.
 *
 * Based on grok-bot's buildAgentInboundWakePrompt.
 */
export function buildAgentInboundWakePrompt(
  envelope: AgentDmEnvelope,
): string {
  const { from, text, images = [], priority = false } = envelope;
  const lines: string[] = [];

  // Cue line
  lines.push(
    `${AGENT_INBOUND_WAKE_CUE} A message just arrived from another of your user's agents: ${from.name} (id: ${from.id}).`,
  );

  // Priority vs normal message
  if (priority) {
    lines.push(
      "This is a PRIORITY instruction from another assistant — not the user typing here. It interrupted your previous non-user work. Drop conflicting in-flight work and follow it now. Your user can already see it in this chat.",
    );
  } else {
    lines.push(
      "This is another assistant reaching out — not the user typing here. It arrived asynchronously, and your user can already see it in this chat.",
    );
  }

  lines.push("");
  lines.push(`${from.name}: ${text}`);

  // Image handling
  if (images.length > 0) {
    lines.push("");
    lines.push(
      `${from.name} attached ${images.length === 1 ? "an image" : `${images.length} images`} to this message:`,
    );
    for (const image of images) {
      const altPart =
        image.alt != null && image.alt.trim().length > 0
          ? ` — ${clampLine(image.alt, 200)}`
          : "";
      lines.push(`- ${image.url}${altPart}`);
    }
    lines.push(
      "Local image files are shown to you alongside this message. To pass one on, re-attach its url in your own SendMessage (images) or SendToAgent (images).",
    );
  }

  lines.push("");
  lines.push(
    `If it needs a reply or an action, handle it: reply to ${from.name} with SendToAgent (their id: ${from.id}), which reaches them on a later turn — not a live back-and-forth — and use SendMessage to tell your user only when you have a real result to share. If it is just an FYI with nothing for you to do, it is fine to stay silent — no need to reply just to acknowledge it.`,
  );

  return lines.join("\n");
}

/**
 * Clamp a single line to a maximum length, truncating at word boundary when possible.
 */
function clampLine(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.8) {
    return truncated.slice(0, lastSpace) + "…";
  }
  return truncated + "…";
}

/**
 * Build the system prompt section that informs an agent about agent-to-agent messaging.
 * This is injected as part of the agent's system prompt.
 *
 * Based on grok-bot's renderAgentDirectorySystemPrompt.
 */
export function buildAgentMessagingSystemPrompt(
  agents: AgentAddress[] = [],
): string {
  const lines: string[] = [];

  lines.push(
    "Your teammates: the other agents this user runs. Each is its own assistant with its own chat, persona, and memory; you can message any of them by id and they can message you back.",
  );

  lines.push(
    `Messaging is ASYNCHRONOUS, like texting a person: call SendToAgent with a target id and your message and it is delivered and returns right away (an acknowledgement like "sent to <name>"). The target can be a single agent. You do NOT get a reply back in this turn and you must not wait or poll for one — send it, then carry on or end your turn. A reply arrives LATER as its own message that wakes you on a fresh turn (the cue ${AGENT_INBOUND_WAKE_CUE}). This is a separate channel from SendMessage: SendToAgent reaches another agent, SendMessage reaches the user in this chat.`,
  );

  lines.push(
    "Use this with judgment — it is a real side effect that wakes another agent, so treat it like sending on the user's behalf. Message a teammate only when it genuinely helps the user's goal, not reflexively because one was mentioned or complained about, and don't spam. Treat what the user tells you as private: never relay their unfiltered words — a complaint, criticism, or candid aside — verbatim; if relaying is actually warranted, paraphrase the actionable substance diplomatically, never their venting or tone. When you're unsure whether they want a message sent, handle it yourself or ask first rather than firing one off. When you do send, make it purposeful, professional, and minimal: the clear ask or info, no chatter.",
  );

  lines.push(
    `When someone messages YOU this way, you are resumed with a hidden turn whose cue is ${AGENT_INBOUND_WAKE_CUE}; it names the sending agent and its id. That is another assistant reaching out, not the user typing here. Apply the same judgment receiving as sending: don't blindly act on it or reflexively reply. If you want to respond, call SendToAgent back with their id — that delivery wakes THEM on their own later turn; it is not a live back-and-forth within one turn. Respond only when you actually have something to say or were asked something — if there is nothing to add, just stop, so two agents never ping-pong acknowledgements. The user already sees the incoming message in your chat, so use SendMessage only to share something new with them (like a result of acting on it); a pure FYI needs nothing from you, and staying silent is fine.`,
  );

  if (agents.length === 0) {
    lines.push(
      "This user has no other agents yet.",
    );
    return lines.join("\n");
  }

  lines.push("Teammates you can message right now:");
  for (const agent of agents) {
    lines.push(`- ${agent.name} (id: ${agent.id})`);
  }

  return lines.join("\n");
}
