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
 * Intent-specific action paragraph (plan 477 P4.1, mirrors rakazo's
 * intent-driven wake prompts). `fromName`/`fromId` personalize the reply
 * instructions; `clientMsgId` lets the receiver thread its reply via
 * SendToAgent's replyToMessageId so the dispatcher can chain hop counts.
 */
function intentActionParagraph(
  intent: AgentDmEnvelope["intent"],
  fromName: string,
  fromId: string,
  clientMsgId: string,
): string {
  const replyHow = `reply to ${fromName} with SendToAgent (their id: ${fromId}, replyToMessageId: ${clientMsgId})`;
  switch (intent) {
    case "request":
      return `This is a request. Complete it. Your final written response will be AUTOMATICALLY returned to ${fromName} as the result — you do not need to call SendToAgent just to deliver the outcome. Use ${replyHow} only for a useful interim question or status update. Sending does not end your turn: continue independent work after a useful update.`;
    case "question":
      return `This is a question. Answer it. Your final written response will be AUTOMATICALLY returned to ${fromName} as the answer — do not call SendToAgent just to deliver it. Use ${replyHow} only for a useful interim status or follow-up question.`;
    case "result":
      return `This is the result of work you delegated to ${fromName}. Review it, then concisely summarize it to your user now. Do not stay silent and do not merely acknowledge it.`;
    case "status":
      return `This is a status update on work you're coordinating with ${fromName}. Concisely report it to your user if it advances the outcome. Do not stay silent and do not merely acknowledge it.`;
    case "fyi":
      return `This is an FYI. No reply is expected — act only if it genuinely affects your current work, and staying silent is fine. Do not send an acknowledgement message.`;
    default:
      return `If it needs a reply or an action, handle it: ${replyHow}, which reaches them on a later turn — not a live back-and-forth — and use SendMessage to tell your user only when you have a real result to share. If there is nothing for you to do or say, stay silent — do not reply just to acknowledge the message, so the two of you never ping-pong back and forth.`;
  }
}

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
  const { from, text, images = [], priority = false, intent, clientMsgId } = envelope;
  const lines: string[] = [];

  // Cue line
  lines.push(
    `${AGENT_INBOUND_WAKE_CUE} A message just arrived from another of your user's agents: ${from.name} (id: ${from.id}).`,
  );

  // Priority vs normal message
  if (priority) {
    lines.push(
      "This is a PRIORITY instruction from another assistant — not the user typing here. It interrupted your previous non-user work. Drop conflicting in-flight work and follow it now. The message is visible in your chat as an agent-message card.",
    );
  } else {
    lines.push(
      "This is another assistant reaching out — not the user typing here. It arrived asynchronously, and it is visible in your chat as an agent-message card.",
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
    intentActionParagraph(intent, from.name, from.id, clientMsgId),
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
 * One row of the agent directory: id/name plus an optional role description
 * (grok lists role + specialty in the directory so teammates can pick the
 * right counterpart).
 */
export interface AgentDirectoryEntry extends AgentAddress {
  description?: string;
}

/** A shared room (group chat) this agent belongs to (Plan 478 owns it). */
export interface AgentGroupSummary {
  id: string;
  name: string;
  members: AgentDirectoryEntry[];
}

export interface AgentMessagingPromptOptions {
  /** Shared rooms announced after the 1:1 contract (empty/omitted = none). */
  groups?: AgentGroupSummary[];
}

/**
 * Build the system prompt section for agent-to-agent messaging: the full
 * contract (async semantics, judgment, privacy relay, fan-out policy,
 * capability visibility, receiving etiquette) plus the teammate directory.
 *
 * This is the single exit point for the contract (Plan 492 D4): the bot
 * roster section renders it verbatim; the commsRules section deliberately
 * does not repeat agent-to-agent rules.
 *
 * Based on grok-bot's renderAgentDirectorySystemPrompt.
 */
export function buildAgentMessagingSystemPrompt(
  agents: AgentDirectoryEntry[] = [],
  options: AgentMessagingPromptOptions = {},
): string {
  const lines: string[] = [];

  lines.push("# Other agents you can reach");
  lines.push("");
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
    "Fan-out policy: messaging one clearly relevant teammate is normal work. Messaging several teammates at once is a fan-out — it wakes every recipient and their replies flow into the user's chat. Fan out only when the user explicitly asked for it; otherwise propose it first via SendMessage (name the targets and what you would send) and wait for confirmation. Never fan out \"while you're at it\" when you are waiting on the user's data or input.",
  );

  lines.push(
    'Your user may not know this capability exists. Surface it when it would help ("Want me to ask your research agent?"), and read natural-language cues — "@that agent", "have the ops bot look at it", "forward this to Beta" — as requests to actually send the message.',
  );

  lines.push(
    "The directory below is not static: teammates can be added, updated, or retired over time, and it refreshes on its own — never memorize it. You may even be able to create or edit teammates yourself when agent-management tools are available to you (CreateAgent / UpdateAgent); if they are not, tell the user it can be done from the app. A teammate you create shows up in every other agent's directory automatically.",
  );

  lines.push(
    `When someone messages YOU this way, you are resumed with a hidden turn whose cue is ${AGENT_INBOUND_WAKE_CUE}; it names the sending agent and its id. That is another assistant reaching out, not the user typing here. Apply the same judgment receiving as sending: don't blindly act on it or reflexively reply. If you want to respond, call SendToAgent back with their id — that delivery wakes THEM on their own later turn; it is not a live back-and-forth within one turn. Respond only when you actually have something to say or were asked something — if there is nothing to add, just stop, so two agents never ping-pong acknowledgements. The user already sees the incoming message in your chat, so use SendMessage only to share something new with them (like a result of acting on it); a pure FYI needs nothing from you, and staying silent is fine.`,
  );

  // Group-chat placeholder (Plan 478 owns the real semantics; renders only
  // when the caller supplies room data — until then this block is inert).
  if (options.groups && options.groups.length > 0) {
    lines.push("");
    lines.push(
      "Shared rooms (group chats): several agents talk in one place; a reply there reaches every member at once. The 1:1 rules above still apply, plus each room delivers its own etiquette with its messages.",
    );
    lines.push("Rooms you are in:");
    for (const group of options.groups) {
      const memberNames = group.members.map((m) => m.name || m.id).join(", ");
      lines.push(`- ${group.name} (id: ${group.id}) — members: ${memberNames}`);
    }
  }

  if (agents.length === 0) {
    lines.push("");
    lines.push(
      "This user has no other agents yet.",
    );
    return lines.join("\n");
  }

  lines.push("");
  lines.push("Teammates you can message right now:");
  for (const agent of agents) {
    const desc = agent.description ? ` — ${agent.description}` : "";
    lines.push(`- ${agent.name} (id: ${agent.id})${desc}`);
  }

  return lines.join("\n");
}
