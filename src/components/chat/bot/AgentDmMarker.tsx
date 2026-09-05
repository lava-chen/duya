import type { AgentDmCardMeta } from "@/types/message";

interface AgentDmMarkerProps {
  meta: AgentDmCardMeta;
  text: string;
}

const INTENT_LABELS: Record<string, string> = {
  request: "request",
  result: "result",
  question: "question",
  status: "status",
  fyi: "fyi",
};

/**
 * Plan 477 P4.4 — bot→bot DM marker card in the bot-direct transcript.
 * Compact collaboration chip (mirrors rakazo's CollaborationMarker): an
 * arrow + peer name + intent tag, with the message text below. Two
 * directions: sent (→ peer) and received (← peer).
 */
export function AgentDmMarker({ meta, text }: AgentDmMarkerProps) {
  const sent = meta.direction === "sent";
  const intentLabel = meta.intent ? INTENT_LABELS[meta.intent] ?? null : null;
  return (
    <div
      className={`bot-chat-dm-marker ${sent ? "bot-chat-dm-marker--sent" : "bot-chat-dm-marker--received"}`}
      data-direction={meta.direction}
      data-intent={meta.intent ?? undefined}
    >
      <div className="bot-chat-dm-marker__head">
        <span className="bot-chat-dm-marker__arrow" aria-hidden="true">
          {sent ? "→" : "←"}
        </span>
        <span className="bot-chat-dm-marker__peer">
          {sent ? meta.peerName : meta.peerName}
        </span>
        {intentLabel && (
          <span className="bot-chat-dm-marker__intent">{intentLabel}</span>
        )}
        {meta.priority && (
          <span className="bot-chat-dm-marker__priority">priority</span>
        )}
      </div>
      <div className="bot-chat-dm-marker__body">{text}</div>
    </div>
  );
}
