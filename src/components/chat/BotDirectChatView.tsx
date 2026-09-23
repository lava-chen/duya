"use client";

/**
 * BotDirectChatView — Telegram-style 1:1 chat with a bot (plan 483 P2.1,
 * UI aligned with grok-bot's chat stage).
 *
 * Mounted from App.tsx's renderView() as a SIBLING of ChatView (plan
 * 483 P2.1, mount corrected 2026-09-04): the branch keys off
 * `resolveChatMode(activeThreadId)` at the app-level view switch, so
 * ChatView / MessageList / the workspace pipeline never learn about
 * bot mode (plan §6 constraint "分支必须收敛"). The bot view is fully
 * self-contained: it does not run any ChatView hooks and receives the
 * transcript via props.
 *
 * Geometry and behavior borrowed from grok's transcript, hover overlay
 * and row rhythm aligned with rakazo (apps/web Shell.tsx, 2026-09-05):
 *   - full-pane transcript column, rakazo pt-9 rhythm (36px row top
 *     padding that doubles as the landing lane for the previous row's
 *     hanging hover overlay)
 *   - user rows right-aligned (`margin-inline-start: auto`), bot left
 *   - consecutive same-role messages group; group-start rows carry the
 *     bot avatar + name (grok keeps the header-only avatar; the plan
 *     spec asks for 头像+名字色 on the bubble container — group-start
 *     only, Telegram-style, is the merge of both)
 *   - 3-dot typing pill at the bottom while the agent streams
 *   - composer disabled until plan 477 binds a persistent session
 *
 * Out of scope here (later P2 items): tool/thinking collapse (P2.3),
 * send pipeline rewiring (P2.5 / plans 476+481) — onSend rides the
 * bot-direct path. Plan 489 P0.3 (wired 2026-09-05): the transcript
 * comes from the source-filtered `useBotDirectTranscript` projection
 * (send_message | user); the messages prop only contributes in-flight
 * optimistic user bubbles. Plan 489 P2.2 (minimal, 2026-09-05):
 * SendMessage attachment / widget / cursor-agent / secret-request kinds
 * render as minimal cards (BotSendCard); full interactive card family
 * (secret input flow, cursor-agent live status) is still pending.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Composer, type ComposerPayload } from "./Composer";
import { ContextUsageRing } from "./ContextUsageRing";
import { BotBubbleRow } from "./BotBubbleRow";
import { BotToolCallRow } from "./BotToolCallRow";
import { BotThinkingRow } from "./BotThinkingRow";
import { BotActivityIndicator } from "./BotActivityIndicator";
import { AgentDmGroupChip } from "./bot/AgentDmGroupChip";
import {
  buildAgentDmChipGroups,
  isAgentDmMarkerMessage,
  isBotDirectDisplayable,
  type AgentDmChipGroup,
} from "./bot/agent-dm-pair";
import { ChevronDownIcon } from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";
import type { Message } from "@/types/message";

import { useBotContacts } from "@/components/layout/sidebar/use-bot-contacts";
import { useOptionalPanel } from "@/hooks/usePanel";
import { BotCharacterAvatar } from "@/components/layout/sidebar/BotCharacterAvatar";
import { resolveBotAgentId } from "./bot/chat-mode";
import { useBotDirectTranscript } from "./bot/use-bot-direct-transcript";
import { mergeInFlightOptimisticMessages } from "@/stores/conversation-store";
import {
  BotMessageHoverBar,
  BotThumbsBadge,
  useMessageThumbsUp,
} from "./BotMessageHoverBar";
import { BotSendCard, BotSendImageView } from "./BotSendCard";
import { BotToolApprovalCard, type ToolApprovalStatus } from "./bot/BotToolApprovalCard";
import type { TranslationKey } from "@/i18n";
import { splitReplyContent, isReplyContent, type ReplyQuote } from "./bot/reply";
// Plan 494: bot-direct renders its own permission/ask cards — ChatView
// (and its PermissionPrompt sheet) is not mounted in this mode.
import { usePermissions } from "@/hooks/usePermissions";
import {
  subscribeToPermissions,
  subscribeToConnectorAuthRequired,
  clearConnectorAuthRequired,
  type ConnectorAuthRequiredData,
} from "@/lib/stream-session-manager";
import type { PermissionRequestEvent } from "@/types/stream";
import { getAppConnectionAPI } from "@/lib/app-connection-ipc";
import { ConnectorAuthRequiredCard } from "./ConnectorAuthRequiredCard";
import { BotAskCard } from "./bot/BotAskCard";
import { BotPermissionCard } from "./bot/BotPermissionCard";
import { compactContext } from "@/lib/agent-sse-client";
import { useContextUsageStore } from "@/stores/context-usage-store";
import { useSettings } from "@/hooks/useSettings";

export interface BotDirectSendPayload {
  text: string;
  /** Raw model id (no `[provider] ` prefix). Inject by the host from the bot's settings. */
  model?: string;
  /** Provider store id the model belongs to. */
  providerId?: string;
  /** Thinking level bound to the bot's model. */
  reasoning?: 'off' | 'low' | 'medium' | 'high';
  /** Message-level mode (plan-task / research / ...). */
  mode?: string;
  /** User-attached files (files/images). */
  files?: import('@/types/message').FileAttachment[];
  /** Message being replied to. */
  replyTo?: { id: string; text: string };
}

export interface BotDirectChatViewProps {
  sessionId: string;
  messages: Message[];
  isStreaming: boolean;
  isFinalizing: boolean;
  onSend: (payload: BotDirectSendPayload) => void;
  onStop: () => void;
  /** Plan 497: open a DM pair as a full sibling view (App owns the state;
   *  absent → chips render but stay inert, e.g. standalone test renders). */
  onOpenDmPair?: (peerId: string, peerName: string) => void;
}

/** Calendar-day key for grouping messages under date separators. */
function dayKeyOf(timestamp: number): string {
  return new Date(timestamp).toDateString();
}

/** Within-day messages closer than this run in the same bubble group; a gap
 *  at or above it breaks the group and shows an HH:MM time separator
 *  (WeChat-style feed rhythm). */
const WITHIN_DAY_GAP_MS = 5 * 60 * 1000;

/** Day separator label ("token-sand-transcript-time-separator"): relative
 *  "today"/"yesterday" for the nearest two calendar days, otherwise a locale
 *  date with the year omitted when it matches the current one. */
function dateSeparatorLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDay = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
  const diffDays = Math.round((startOfToday - startOfDay) / 86_400_000);
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  return date.getFullYear() === now.getFullYear()
    ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
    : new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

/** Within-day time separator: absolute HH:MM (the finer-grained sibling of
 *  the date separator — shown when the gap to the previous message reaches
 *  WITHIN_DAY_GAP_MS). */
function timeSeparatorLabel(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

interface BubbleRow {
  message: Message;
  role: "user" | "assistant";
  text: string;
  isGroupStart: boolean;
  /** Plan 477 P4.4: renders as a bot→bot DM marker card, not a bubble. */
  isDmMarker?: boolean;
  /** Plan 497: set when this row renders the collapsed DM chip for a run
   *  of consecutive same-peer marker rows (chip replaces the old card). */
  dmGroup?: AgentDmChipGroup;
  /** Reply quote parsed back out of a composed user content (see bot/reply.ts). */
  replyPreview?: ReplyQuote | null;
  /** Standalone image bubble (text-kind message with re-attached images is
   *  split into one image row per image). */
  image?: { url: string; alt?: string };
  /** True when the row renders as a BotBubbleRow (grouping candidate). */
  isBubbleRow?: boolean;
  /** Telegram-style position within a same-role bubble group (CSS keys
   *  the tight spacing + reduced facing corners off this). */
  groupPosition?: "start" | "middle" | "end" | "single";
}

/** Text bubbles only; tool/thinking/system render as slim status rows. */
function isBubbleMessage(message: Message): message is Message & { role: "user" | "assistant" } {
  if (message.role !== "user" && message.role !== "assistant") return false;
  const type = message.msgType;
  return type == null || type === 'text';
}

/** Plan 477 P4.4 marker detection lives in bot/agent-dm-pair.ts (plan 497). */

function textFromContent(content: Message["content"] | Message["displayContent"]): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as Record<string, unknown>;
    if (typed.type === "text" && typeof typed.text === "string") {
      parts.push(typed.text);
    }
  }
  return parts.join("\n");
}

/** Status rows: tool_call → BotToolCallRow, thinking → BotThinkingRow. */
function StatusRow({ message }: { message: Message }) {
  if (message.msgType === "thinking" && message.thinking) {
    return (
      <BotThinkingRow
        text={message.thinking}
        isStreaming={message.status === "streaming"}
      />
    );
  }
  if (message.msgType === "tool_use" && message.toolName) {
    return (
      <BotToolCallRow
        name={message.toolName}
        status={(message.status as "pending" | "running" | "done" | "failed" | "aborted") || "pending"}
        summary={typeof message.content === 'string' ? message.content.slice(0, 100) : undefined}
        toolInput={message.toolInput ?? undefined}
      />
    );
  }
  return null;
}

/**
 * Plan 489 P2.2 — SendMessage kinds that render as minimal cards instead
 * of plain bubbles. Card rows live INSIDE the assistant bubble chrome so
 * grouping/colors stay consistent; widget options click-send via onSend.
 */
function isSendCardMessage(message: Message): boolean {
  if (message.role !== "assistant") return false;
  const type = message.msgType;
  // text with re-attached images is NOT a card here — it splits into a plain
  // text bubble plus one standalone image bubble per image (see rows below).
  if (
    type === 'attachment' ||
    type === 'widget' ||
    type === 'cursor-agent' ||
    type === 'secret-request' ||
    // Plan 498: durable tool-approval card.
    type === 'tool-approval'
  ) {
    return true;
  }
  return false;
}

function SendCardRow({
  message,
  onOptionClick,
  onReply,
  approvalStatus,
  onApprovalResolve,
  t,
  groupPosition,
}: {
  message: Message;
  onOptionClick?: (option: string) => void;
  onReply?: () => void;
  approvalStatus?: ToolApprovalStatus;
  onApprovalResolve?: (id: string, decision: 'allow' | 'always' | 'deny') => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  groupPosition?: BubbleRow["groupPosition"];
}) {
  const [thumbsUp, toggleThumbsUp] = useMessageThumbsUp(message.id);
  const approval = message.sendMessageMeta?.approval;
  const grouped = groupPosition === "middle" || groupPosition === "end";
  const seamClass = groupPosition
    ? ` bot-chat-bubble--group-${groupPosition}`
    : "";
  return (
    <div
      className={`bot-chat-row${grouped ? " bot-chat-row--grouped" : ""} bot-chat-row--assistant`}
      data-role="assistant"
    >
      <div className="bot-chat-row__stack">
        {/* The card surface replaces the chat bubble — a single chrome layer
            (rakazo BuiCard), NOT a card nested inside a bubble. The seam
            modifiers reuse the bubble class names so the card joins the same
            corner-grouping rhythm as text bubbles. */}
        <div className={`bot-send-card-surface${seamClass}`}>
          {message.msgType === 'tool-approval' && approval ? (
            <BotToolApprovalCard
              approval={approval}
              status={approvalStatus ?? 'pending'}
              onResolve={onApprovalResolve}
              t={t}
            />
          ) : (
            <BotSendCard message={message} onOptionClick={onOptionClick} />
          )}
        </div>
        {thumbsUp && <BotThumbsBadge onRemove={toggleThumbsUp} />}
        <BotMessageHoverBar
          timestamp={message.timestamp}
          textToCopy={typeof message.content === 'string' ? message.content : undefined}
          messageId={message.id}
          thumbsUp={thumbsUp}
          onToggleThumbsUp={toggleThumbsUp}
          onReply={onReply}
        />
      </div>
    </div>
  );
}

/**
 * A standalone image bubble: the borderless preview in the assistant bubble
 * chrome, grouped like any other bubble. Shares the hover bar + thumb actions.
 */
function BotImageRow({
  message,
  image,
  onReply,
  groupPosition,
}: {
  message: Message;
  image: { url: string; alt?: string };
  onReply?: () => void;
  groupPosition?: BubbleRow["groupPosition"];
}) {
  const [thumbsUp, toggleThumbsUp] = useMessageThumbsUp(message.id);
  const grouped = groupPosition === "middle" || groupPosition === "end";
  return (
    <div
      className={`bot-chat-row${grouped ? " bot-chat-row--grouped" : ""} bot-chat-row--assistant`}
      data-role="assistant"
    >
      <div className="bot-chat-row__stack">
        <BotSendImageView
            image={image}
            groupPosition={groupPosition === "single" ? undefined : groupPosition}
          />
        {thumbsUp && <BotThumbsBadge onRemove={toggleThumbsUp} />}
        <BotMessageHoverBar
          timestamp={message.timestamp}
          messageId={message.id}
          thumbsUp={thumbsUp}
          onToggleThumbsUp={toggleThumbsUp}
          onReply={onReply}
        />
      </div>
    </div>
  );
}

/** Answered AskUserQuestion trace kept in memory for the session (plan 494). */
interface AnsweredAsk {
  id: string;
  questions: Array<{ question: string; header?: string }>;
  answers: Record<string, string>;
  /** Transcript row count at submit time — splices the trace back into
   *  the flow at its true chronological position (the stream is paused
   *  while awaiting permission, so that point is exact). */
  anchor: number;
}

/** Static answered card — keeps the Q&A visible after submission. */
function AnsweredAskRow({
  ask,
  groupPosition,
}: {
  ask: AnsweredAsk;
  groupPosition?: BubbleRow["groupPosition"];
}) {
  const grouped = groupPosition === "middle" || groupPosition === "end";
  const seamClass = groupPosition
    ? ` bot-chat-bubble--group-${groupPosition}`
    : "";
  return (
    <div
      className={`bot-chat-row${grouped ? " bot-chat-row--grouped" : ""} bot-chat-row--assistant`}
      data-role="assistant"
    >
      {/* Seam modifiers reuse the bubble class names — the CSS targets the
          modifier class inside the assistant row, so cards join the same
          corner-grouping rhythm as bubbles. */}
      <div
        className={`bot-ask-card bot-ask-card--answered${seamClass}`}
        data-permission-id={ask.id}
      >
        <div className="bot-ask-card__head">
          <span className="bot-ask-card__pill bot-ask-card__pill--answered">
            {ask.questions.length > 1
              ? `✓ · ${ask.questions.length}`
              : "✓"}
          </span>
        </div>
        {ask.questions.map((q, i) => (
          <div className="bot-ask-card__question" key={`${i}-${q.question}`}>
            <div className="bot-ask-card__question-head">
              {q.header && <span className="bot-ask-card__tag">{q.header}</span>}
              <p className="bot-ask-card__question-text">{q.question}</p>
            </div>
            <div className="bot-ask-card__answered-answer">
              {ask.answers[q.question] || "—"}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function BotDirectChatView({
  sessionId,
  messages: messagesProp,
  isStreaming,
  isFinalizing,
  onSend,
  onStop,
  onOpenDmPair,
}: BotDirectChatViewProps) {
  const { t } = useTranslation();
  const { allContacts: contacts, reload: reloadContacts } = useBotContacts();
  // Mention-chip sources: `@Name` tokens in any bubble resolve against the
  // contact roster (grok sand-mention parity, see bot/mention-text.tsx).
  const contactNames = useMemo(() => contacts.map((c) => c.name), [contacts]);
  // Soft dependency: the panel may be absent (tests, standalone renders);
  // the header button then just stays inert instead of crashing the view.
  const panel = useOptionalPanel() ?? null;
  const openOrActivatePage = panel?.openOrActivatePage ?? null;
  const { settings } = useSettings();
  const agentId = resolveBotAgentId(sessionId);

  // The bot-settings panel saves through its own contact list; this event
  // refreshes our copy so the header name/avatar follow immediately
  // (same decoupled window-event pattern as the office-panel open).
  useEffect(() => {
    const handleIdentityUpdated = () => {
      void reloadContacts();
    };
    window.addEventListener("duya:bot-identity-updated", handleIdentityUpdated);
    return () => window.removeEventListener("duya:bot-identity-updated", handleIdentityUpdated);
  }, [reloadContacts]);

  // Plan 489 P0.3 — bot-direct projection (wired 2026-09-05). The hook
  // returns the server-side source-filtered transcript (send_message |
  // user only); tool_use / thinking / scratchpad / system rows never
  // leave the main process. User rows need no filtering — anything with
  // source 'user' is visible by definition.
  //
  // The `messages` prop (conversation store) still matters for ONE thing:
  // the in-flight optimistic user bubble. The worker persists the user
  // row only at turn end, so between "send clicked" and "message:new
  // broadcast" the bubble lives solely in the store. Merge it in with
  // the shared logical-send dedupe (persisted rows win). When the IPC is
  // not wired (web build / jsdom tests) the hook bails out empty and the
  // prop transcript renders as-is.
  const { messages: persistedTranscript, usageMessages, refresh: refreshTranscript } = useBotDirectTranscript(sessionId);
  const ipcWired =
    typeof window !== "undefined" &&
    !!window.electronAPI?.message?.botDirectGetTranscript;
  const messages = useMemo(() => {
    if (!ipcWired) return messagesProp;
    return mergeInFlightOptimisticMessages(persistedTranscript, messagesProp).merged;
  }, [ipcWired, persistedTranscript, messagesProp]);

  const contact = useMemo(
    () => contacts.find((c) => c.agentId === agentId) ?? null,
    [contacts, agentId],
  );

  const botName = contact?.name ?? agentId ?? sessionId;
  const subtitle = contact?.title || contact?.description || "";
  // Plan 491 P1.2 / 477 P3.1: the persistent bot session is now lazily
  // created server-side on first send (`session:ensureBot`), so a 2-part
  // placeholder id (`bot:<agentId>`) is directly sendable — the old
  // boundThreadId (3-part) requirement permanently disabled the composer.
  // The bot only needs to exist in the configured roster.
  const canSendToBot = contact != null;
  const busy = isStreaming || isFinalizing;

  // Manual context compression (context-ring "compress" button): mirrors
  // ChatView's handleCompact. The bot's session goes through the same agent
  // server `/sessions/:id/compact` endpoint, so the button is the proactive
  // trigger for the worker's compaction process.
  const [isCompacting, setIsCompacting] = useState(false);
  const [compressionNotice, setCompressionNotice] = useState<string | null>(null);
  const compressionNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showCompressionNotice = useCallback((message: string) => {
    if (compressionNoticeTimer.current) clearTimeout(compressionNoticeTimer.current);
    setCompressionNotice(message);
    compressionNoticeTimer.current = setTimeout(() => setCompressionNotice(null), 5000);
  }, []);

  // Plan 494 — permission surface for bot-direct. The bot session's
  // startStream already routes permission_request events into the shared
  // stream-session-manager, but nothing subscribed in this mode (ChatView
  // is unmounted), so AskUserQuestion / tool approvals deadlocked the
  // stream until expiry. Same hook + respond channel as ChatView;
  // bot-direct is an 'auto' surface (App.handleBotDirectSend).
  const {
    pendingPermission,
    respondToPermission,
    handlePermissionRequest,
  } = usePermissions({ sessionId, permissionProfile: 'auto' });
  useEffect(() => {
    return subscribeToPermissions(sessionId, (req) => handlePermissionRequest(req));
  }, [sessionId, handlePermissionRequest]);

  // Plan 503: connector elicitation card for bot-direct. `connect_app` /
  // reauth surfaces `chat:connector_auth_required`, which the shared
  // stream-session-manager already routes into `pendingConnectorAuthRequest`
  // (this session's startStream registers createStreamEventHandler). ChatView
  // renders the card; bot-direct was the one surface that never subscribed,
  // so the card never appeared here. Mirrors ChatView's wiring but hands the
  // resume message through the bot composer (onSend).
  const [pendingAuthRequest, setPendingAuthRequest] = useState<ConnectorAuthRequiredData | null>(null);
  const pendingAuthRequestRef = useRef(pendingAuthRequest);
  useEffect(() => {
    pendingAuthRequestRef.current = pendingAuthRequest;
  }, [pendingAuthRequest]);
  const [authCompletedFor, setAuthCompletedFor] = useState<string | null>(null);
  const resumeTriggeredRef = useRef<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    const unsubscribe = subscribeToConnectorAuthRequired(sessionId, (data) => {
      resumeTriggeredRef.current = null;
      setAuthCompletedFor(null);
      setPendingAuthRequest(data);
    });
    return () => unsubscribe();
  }, [sessionId]);

  const dismissAuthRequest = useCallback(() => {
    setPendingAuthRequest(null);
    clearConnectorAuthRequired(sessionId);
  }, [sessionId]);

  // After a successful connect/reauth, clear the pending card and send a
  // localized resume message through the composer so the model continues in
  // the same turn (a bot-initiated connect has no failed call to re-issue —
  // it carries its own resume copy).
  const retryAfterAuth = useCallback(() => {
    const request = pendingAuthRequestRef.current;
    setPendingAuthRequest(null);
    setAuthCompletedFor(null);
    clearConnectorAuthRequired(sessionId);
    if (!request?.provider || resumeTriggeredRef.current === request.provider) {
      return;
    }
    resumeTriggeredRef.current = request.provider;
    onSend?.({
      text:
        request.variant === 'connect'
          ? t('connectorAuth.connectResumeMessage', { provider: request.provider })
          : t('connectorAuth.resumeMessage', {
              provider: request.provider,
              tool: request.toolName ?? '',
            }),
    });
  }, [sessionId, onSend, t]);

  // Main-process completion broadcast — covers authorization finished from
  // the settings page while this card was pending.
  useEffect(() => {
    if (!sessionId) return;
    const api = getAppConnectionAPI();
    if (!api) return;
    return api.onConnected((data) => {
      const request = pendingAuthRequestRef.current;
      if (!request || request.provider !== data.provider) return;
      setAuthCompletedFor(data.provider);
    });
  }, [sessionId]);

  // Plan 498: durable tool-approval card states, hydrated from the approval
  // side table and kept live via the `tool-approval:updated` broadcast (the
  // resolver IPC fires it for every window after a CAS transition).
  const [approvalStatuses, setApprovalStatuses] = useState<Record<string, ToolApprovalStatus>>({});
  useEffect(() => {
    let disposed = false;
    setApprovalStatuses({});
    const api = window.electronAPI;
    void api?.toolApproval
      .listBySession(sessionId)
      .then((rows) => {
        if (disposed) return;
        const next: Record<string, ToolApprovalStatus> = {};
        for (const row of rows as Array<{ id: string; status: ToolApprovalStatus }>) {
          next[row.id] = row.status;
        }
        setApprovalStatuses(next);
      })
      .catch(() => {
        // Hydration is best-effort — cards fall back to the pending look.
      });
    const unsubscribe = api?.toolApproval.onUpdated((data) => {
      if (data.sessionId !== sessionId) return;
      setApprovalStatuses((prev) => ({ ...prev, [data.id]: data.status as ToolApprovalStatus }));
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [sessionId]);

  const handleApprovalResolve = useCallback(
    (id: string, decision: 'allow' | 'always' | 'deny') => {
      void window.electronAPI?.toolApproval.resolve(id, decision);
    },
    [],
  );

  // Answered asks stay visible as static cards for the session (the
  // tool_use rows behind them are source-filtered out of the transcript).
  // In-memory only; cleared on session switch. Persistence is a 489 P2.5
  // follow-up.
  const [answeredAsks, setAnsweredAsks] = useState<AnsweredAsk[]>([]);
  useEffect(() => {
    setAnsweredAsks([]);
  }, [sessionId]);

  // Reply targeting (rakazo onReply parity): hover-bar Reply sets the
  // target, the composer chip shows/cancels it, and the next send carries
  // it as `replyTo` (composed into the outgoing content by
  // App.handleBotDirectSend via composeReplyContent). Cleared on send and
  // on session switch.
  const [replyTarget, setReplyTarget] = useState<ReplyQuote | null>(null);
  useEffect(() => {
    setReplyTarget(null);
  }, [sessionId]);

  const handleReply = useCallback((row: BubbleRow) => {
    setReplyTarget({
      id: row.message.id,
      text: row.text || (row.message.msgType === 'tool_use' && row.message.toolName ? row.message.toolName : ''),
    });
  }, []);

  // Row count as of the latest render — read at submit time to anchor the
  // answered trace to its chronological slot in the transcript. Declared
  // after `rows` (assigned in an effect below).
  const rowAnchorRef = useRef(0);

  const handleAskSubmit = useCallback(
    (request: PermissionRequestEvent, updatedInput: Record<string, unknown>) => {
      const questions = ((request.toolInput as { questions?: unknown } | undefined)?.questions ??
        []) as Array<{ question: string; header?: string }>;
      const answers = (updatedInput.answers ?? {}) as Record<string, string>;
      setAnsweredAsks((prev) => [
        ...prev.slice(-3),
        { id: request.id, questions, answers, anchor: rowAnchorRef.current },
      ]);
      void respondToPermission('allow', updatedInput);
    },
    [respondToPermission],
  );

  const isAskPending =
    pendingPermission != null &&
    (pendingPermission.toolName === 'AskUserQuestion' ||
      pendingPermission.mode === 'ask_user_question');

  const transcriptRef = useRef<HTMLDivElement | null>(null);
  // Plan 491 P0.4: scroll freeze detection
  const [isScrolledUp, setIsScrolledUp] = useState(false);

  // Reply preview click — scroll the quoted message back into view.
  // Rows carry data-message-id (BotBubbleRow); the transcript container
  // scopes the lookup. Unknown ids (message pruned mid-session) no-op.
  const jumpToMessage = useCallback((messageId: string) => {
    const root = transcriptRef.current;
    if (!root) return;
    let escaped: string;
    try {
      escaped = CSS.escape(messageId);
    } catch {
      escaped = messageId.replace(/"/g, '\\"');
    }
    const target = root.querySelector(`[data-message-id="${escaped}"]`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  // Group consecutive same-role messages; a group start shows the bot
  // avatar + name (bot side only — user rows are compact, Telegram-style).
  const rows = useMemo<BubbleRow[]>(() => {
    // Plan 497 — collapse consecutive same-peer DM marker rows into one
    // chip, emitted at the FIRST member's position; the rest are dropped.
    const dmInfoByRowId = new Map<string, { group: AgentDmChipGroup; first: boolean }>();
    for (const group of buildAgentDmChipGroups(messages)) {
      group.memberIds.forEach((id, i) => dmInfoByRowId.set(id, { group, first: i === 0 }));
    }
    const result: BubbleRow[] = [];
    let previousRole: string | null = null;
    for (const message of messages) {
      // Canonical bot-direct display predicate (agent-dm-pair): enforces the
      // visible-source allowlist AND drops every internal/system row (task
      // notifications, compaction summary/boundary markers, agent-DM wake
      // cues) in one place. This row builder, the transcript hook, and the
      // realtime merge all branch on the same predicate — the earlier four
      // divergent filters are gone.
      if (!isBotDirectDisplayable(message)) continue;
      // Plan 477 P4.4: DM marker rows render as their own card type — they
      // do not participate in bubble grouping (previousRole unchanged).
      if (isAgentDmMarkerMessage(message)) {
        const info = dmInfoByRowId.get(message.id);
        if (info?.first) {
          result.push({
            message,
            role: "assistant",
            text: "",
            isGroupStart: false,
            isDmMarker: true,
            dmGroup: info.group,
          });
        }
        continue;
      }
      if (isBubbleMessage(message)) {
        const rawText = textFromContent(
          message.role === "user" ? (message.displayContent ?? message.content) : message.content,
        );
        // Reply-quote extraction (bot/reply.ts): a composed user content
        // carries the `[Replying to <id>]` sentinel; the bubble body stays
        // plain (displayContent / the parsed tail) and the quote renders
        // as the clickable preview above the bubble.
        let replyPreview: ReplyQuote | null = null;
        let text = rawText;
        // typeof narrow: isReplyContent accepts unknown and cannot narrow
        // message.content for splitReplyContent's string parameter.
        if (
          message.role === "user" &&
          typeof message.content === "string" &&
          isReplyContent(message.content)
        ) {
          const split = splitReplyContent(message.content);
          if (split.reply) {
            replyPreview = split.reply;
            text =
              typeof message.displayContent === 'string'
                ? message.displayContent
                : split.text;
          }
        }
        // A caption-less image message (text kind + sendMessageMeta.images)
        // still renders — each image as its own standalone bubble.
        const attachedImages = message.role === 'assistant'
          ? (message.sendMessageMeta?.images ?? []).map((img) => ({
              url: img.url,
              alt: img.alt,
            }))
          : undefined;
        if (!text.trim() && !attachedImages?.length) continue;
        if (text.trim()) {
          result.push({
            message,
            role: message.role,
            text,
            isGroupStart: previousRole !== message.role,
            replyPreview,
            isBubbleRow: true,
          });
          previousRole = message.role;
        }
        // Re-attached images render as standalone image bubbles — never inside
        // the text bubble.
        for (const image of attachedImages ?? []) {
          result.push({
            message,
            role: message.role,
            text: "",
            isGroupStart: previousRole !== message.role,
            image,
            isBubbleRow: true,
          });
          previousRole = message.role;
        }
      } else {
        // Status row (tool/thinking/hook): does not reset bubble grouping —
        // an assistant text after its tool calls continues the same group.
        result.push({ message, role: "assistant", text: "", isGroupStart: false });
      }
    }
    // Telegram-style bubble grouping (screenshot parity): consecutive
    // same-role bubble rows on the same calendar day form ONE visual
    // group — group members after the first sit on the tight spacing lane
    // and the corners FACING a neighbor take the reduced radius
    // (.bot-chat-row--grouped / .bot-chat-bubble--group-{start,middle,end}).
    let openStart = -1;
    let prev: BubbleRow | null = null;
    let prevIdx = -1;
    const closeBubbleGroup = () => {
      if (openStart < 0 || prevIdx < 0) return;
      if (prevIdx === openStart) {
        result[openStart].groupPosition = "single";
      } else {
        result[openStart].groupPosition = "start";
        for (let j = openStart + 1; j < prevIdx; j++) result[j].groupPosition = "middle";
        result[prevIdx].groupPosition = "end";
      }
    };
    for (let i = 0; i < result.length; i++) {
      const row = result[i];
      if (row.isBubbleRow !== true) continue;
      const joins =
        prev != null &&
        prev.role === row.role &&
        dayKeyOf(prev.message.timestamp) === dayKeyOf(row.message.timestamp) &&
        row.message.timestamp - prev.message.timestamp < WITHIN_DAY_GAP_MS;
      if (!joins) {
        closeBubbleGroup();
        openStart = i;
      }
      prev = row;
      prevIdx = i;
    }
    closeBubbleGroup();
    return result;
  }, [messages]);

  // Renders one transcript row (with date separator when the calendar day
  // changes). Extracted so answered-ask traces can splice between rows at
  // their chronological anchor (plan 494). `groupOverride` upgrades a row's
  // computed group position when a CARD follows it (pending permission/ask
  // card, spliced answered card): the card inherits the seam, so the row
  // must keep its bottom seam tight (single→start, end→middle).
  const renderRow = useCallback(
    (row: BubbleRow, index: number, groupOverride?: BubbleRow["groupPosition"]): React.ReactNode => {
      // Date separator before the first row of each calendar day
      // (grok sand-transcript-time-separator). Rows with an invalid
      // timestamp (NaN/undefined) must not reach Intl.format — it
      // throws RangeError and takes down the whole transcript render
      // — so such rows are skipped instead.
      const previous = rows[index - 1];
      const rowFinite = Number.isFinite(row.message.timestamp);
      const prevFinite = previous != null && Number.isFinite(previous.message.timestamp);
      const dayChanged =
        previous != null &&
        dayKeyOf(previous.message.timestamp) !== dayKeyOf(row.message.timestamp);
      const showSeparator =
        rowFinite && (previous == null || dayChanged);
      // WeChat-style within-day time separator: same calendar day but the gap
      // to the previous message reaches WITHIN_DAY_GAP_MS → show HH:MM (the
      // row also already starts a fresh bubble group).
      const showTimeSeparator =
        rowFinite && prevFinite && !dayChanged &&
        row.message.timestamp - previous!.message.timestamp >= WITHIN_DAY_GAP_MS;
      const element = isSendCardMessage(row.message) ? (
        <SendCardRow
          key={row.message.id}
          message={row.message}
          onOptionClick={(option) => onSend({ text: option })}
          onReply={() => handleReply(row)}
          approvalStatus={
            row.message.sendMessageMeta?.approval
              ? approvalStatuses[row.message.sendMessageMeta.approval.approvalId]
              : undefined
          }
          onApprovalResolve={handleApprovalResolve}
          t={t}
          groupPosition={groupOverride ?? row.groupPosition}
        />
      ) : row.image ? (
        <BotImageRow
          key={`${row.message.id}-${row.image.url}`}
          message={row.message}
          image={row.image}
          onReply={() => handleReply(row)}
          groupPosition={groupOverride ?? row.groupPosition}
        />
      ) : row.isDmMarker && row.dmGroup ? (
        <AgentDmGroupChip
          key={row.dmGroup.key}
          group={row.dmGroup}
          resolvePeer={(peerId) => {
            const c = contacts.find((x) => x.agentId === peerId);
            return { name: c?.name, avatarUrl: c?.avatarUrl, avatarColor: c?.avatarColor };
          }}
          onOpenPeer={(peerId, peerName) => onOpenDmPair?.(peerId, peerName)}
        />
      ) : row.text || row.replyPreview ? (
        <BotBubbleRow
          key={row.message.id}
          role={row.role}
          messageId={row.message.id}
          timestamp={row.message.timestamp}
          text={row.text}
          mentionNames={contactNames}
          onReply={() => handleReply(row)}
          replyPreview={row.replyPreview}
          onJumpToReply={jumpToMessage}
          groupPosition={groupOverride ?? row.groupPosition}
        />
      ) : (
        <StatusRow key={row.message.id} message={row.message} />
      );
      const separator = showSeparator ? (
        <div className="bot-chat-date-separator" role="separator">
          {dateSeparatorLabel(row.message.timestamp)}
        </div>
      ) : showTimeSeparator ? (
        <div className="bot-chat-time-separator" role="separator">
          {timeSeparatorLabel(row.message.timestamp)}
        </div>
      ) : null;
      return separator ? (
        <React.Fragment key={row.message.id}>
          {separator}
          {element}
        </React.Fragment>
      ) : (
        element
      );
    },
    [rows, onSend, handleReply, jumpToMessage, contacts, contactNames],
  );

  // Pending card seam (permission/ask cards): the card joins the tail
  // bubble group when the last transcript row is an assistant-side
  // bubble/card run member from the same calendar day (a date separator
  // would otherwise render between them — never group across one).
  const tailCardJoins = useMemo(() => {
    if (!pendingPermission || answeredAsks.some((a) => a.id === pendingPermission.id))
      return false;
    const last = rows[rows.length - 1];
    return (
      !!last &&
      last.role === "assistant" &&
      last.isBubbleRow === true &&
      Number.isFinite(last.message.timestamp) &&
      dayKeyOf(last.message.timestamp) === dayKeyOf(Date.now())
    );
  }, [pendingPermission, answeredAsks, rows]);

  // Interleave answered-ask traces into the transcript at their submit-time
  // anchor so a trace sits BETWEEN the messages around its question — a new
  // pending ask must always appear AFTER older answered cards (plan 494
  // ordering fix). Cards participate in the bubble group: a spliced card
  // joins the assistant-side run before it (seam upgrade on the previous
  // member), and the following row keeps its own seam when it was computed
  // to join the same run.
  const transcriptNodes = useMemo<React.ReactNode[]>(() => {
    const upgradeForCard = (
      pos: BubbleRow["groupPosition"],
    ): BubbleRow["groupPosition"] =>
      pos === "single" ? "start" : pos === "end" ? "middle" : pos;
    // Does a card spliced at `anchor` join the assistant-side group that
    // ends at rows[anchor - 1]? Never across a date-separator boundary
    // (the next row would render one between the pair).
    const joinsPrevGroup = (anchor: number): boolean => {
      const prevRow = rows[anchor - 1];
      const nextRow = rows[anchor];
      if (!prevRow || prevRow.role !== "assistant" || prevRow.isBubbleRow !== true)
        return false;
      if (nextRow && !Number.isFinite(nextRow.message.timestamp)) return false;
      return (
        !nextRow ||
        dayKeyOf(prevRow.message.timestamp) === dayKeyOf(nextRow.message.timestamp)
      );
    };
    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    for (const ask of answeredAsks) {
      const anchor = Math.min(ask.anchor, rows.length);
      const joins = joinsPrevGroup(anchor);
      const nextRow = rows[anchor];
      const nextContinuesRun =
        joins &&
        !!nextRow &&
        nextRow.role === "assistant" &&
        (nextRow.groupPosition === "middle" || nextRow.groupPosition === "end");
      for (let i = cursor; i < anchor; i++) {
        nodes.push(
          renderRow(
            rows[i],
            i,
            joins && i === anchor - 1 ? upgradeForCard(rows[i].groupPosition) : undefined,
          ),
        );
      }
      nodes.push(
        <AnsweredAskRow
          key={ask.id}
          ask={ask}
          groupPosition={joins ? (nextContinuesRun ? "middle" : "end") : "single"}
        />,
      );
      cursor = anchor;
    }
    // Pending permission/ask cards always render AFTER all rows — they
    // join the tail group the same way (seam upgrade on the last member).
    for (let i = cursor; i < rows.length; i++) {
      nodes.push(
        renderRow(
          rows[i],
          i,
          tailCardJoins && i === rows.length - 1
            ? upgradeForCard(rows[i].groupPosition)
            : undefined,
        ),
      );
    }
    return nodes;
  }, [rows, answeredAsks, renderRow, pendingPermission, tailCardJoins]);

  // Keep the submit-time anchor current with the latest transcript length.
  useEffect(() => {
    rowAnchorRef.current = rows.length;
  }, [rows]);

  // Plan 491 P0.4: scroll freeze detection
  const handleScroll = () => {
    const el = transcriptRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setIsScrolledUp(distanceFromBottom > 100);
  };

  // Follow new content like the workspace transcript does.
  // Plan 491 P0.4: only auto-scroll if user hasn't scrolled up
  useEffect(() => {
    const el = transcriptRef.current;
    if (el && !isScrolledUp) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, isStreaming, isScrolledUp]);

  // Manual context compression: POST /sessions/:id/compact, same endpoint
  // ChatView's ring uses. The worker broadcasts a fresh post-compaction
  // token_usage before compact:done, so the live ring snapshot is
  // authoritative — keep it; only clear when no fresh frame arrived.
  const handleCompact = useCallback(() => {
    if (!sessionId || isCompacting) return;
    const compactStartedAt = Date.now();
    setIsCompacting(true);
    compactContext(sessionId, {
      onDone: (result) => {
        setIsCompacting(false);
        const live = useContextUsageStore.getState().liveBySession[sessionId];
        if (!live || live.updatedAt < compactStartedAt) {
          useContextUsageStore.getState().clearLive(sessionId);
        }
        // Re-fetch the transcript so the ring re-anchors on the compacted
        // history (compacted rows are superseded server-side).
        void refreshTranscript();
        let removedMsg: string;
        if (result.strategy === 'none') {
          removedMsg = 'No compaction needed (conversation too short)';
        } else if (result.removedCount == null || result.removedCount === 0) {
          removedMsg = 'Compaction ran, nothing removed';
        } else {
          removedMsg = `${result.removedCount} messages compacted`;
        }
        const tokenMsg =
          result.tokenReduction != null && result.tokenReduction > 0
            ? `, ~${Math.round(result.tokenReduction)} tokens saved`
            : '';
        showCompressionNotice(`${removedMsg}${tokenMsg}.`);
      },
      onError: (error) => {
        setIsCompacting(false);
        showCompressionNotice(`Compression failed: ${error}`);
      },
    });
  }, [sessionId, isCompacting, refreshTranscript, showCompressionNotice]);

  // Composer send: attach the active reply target (App composes it into
  // the outgoing content) and clear the chip, rakazo send parity. The
  // model/provider come from the bot's settings (config.toml `[agents.<id>]`)
  // via the contact — there is no per-chat model picker in the bot composer.
  const handleComposerSend = useCallback(
    (payload: ComposerPayload) => {
      onSend({
        ...payload,
        model: contact?.model || undefined,
        providerId: contact?.provider || undefined,
        reasoning: contact?.reasoning,
        replyTo: replyTarget ?? undefined,
      });
      setReplyTarget(null);
    },
    [onSend, replyTarget, contact],
  );



  return (
    <div className="bot-chat-view">
      {/* Manual-compression result toast (context-ring "compress" button). */}
      {compressionNotice && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 animate-in fade-in slide-in-from-top-2 duration-300 pointer-events-none">
          <div className="flex items-center gap-2 px-4 py-2 bg-blue-500/90 text-white text-sm rounded-lg shadow-lg backdrop-blur-sm">
            <span>{compressionNotice}</span>
          </div>
        </div>
      )}
      <header className="bot-chat-header">
        <button
          type="button"
          className="bot-chat-header__identity"
          title={subtitle || undefined}
          onClick={() => {
            if (!contact || !panel) return;
            // Toggle: clicking the header closes the settings panel only when
            // it is currently OPEN and the active tab; otherwise open/activate
            // it. `panelOpen` matters: the panel can be collapsed (drawer
            // toggle) while the bot-settings tab is still active — in that
            // state clicking the header must re-OPEN, not "close" the remaining
            // tab away. Closing goes through the same closePanel the tab's own
            // X uses, so activeTabId is cleared and the next click opens cleanly.
            const existing = panel.tabs.find(
              (t) => t.pageId === "bot-settings" && t.params?.agentId === contact.agentId,
            );
            if (existing && panel.panelOpen && panel.activeTabId === existing.id) {
              panel.closePanel(existing.id);
              return;
            }
            panel.openOrActivatePage("bot-settings", {
              agentId: contact.agentId,
              title: botName,
            });
          }}
          disabled={!contact}
          aria-label={t("panel.botSettings")}
        >
          <span className="bot-chat-header__avatar">
            <BotCharacterAvatar
              name={botName}
              agentId={agentId ?? sessionId}
              avatarUrl={contact?.avatarUrl}
              avatarColor={contact?.avatarColor}
              avatarEmoji={contact?.avatarEmoji}
              size={28}
            />
          </span>
          <span className="bot-chat-header__name">{botName}</span>
        </button>
      </header>

      {/* Scroll wrapper hosts the bottom fade overlay: the overlay must be
          a sibling of the scroll container (not a child) so it stays pinned
          to the visible bottom edge and does not scroll with content. */}
      <div className="bot-chat-transcript-wrap">
        <div
          className="bot-chat-transcript"
          ref={transcriptRef}
          role="log"
          aria-live="off"
          onScroll={handleScroll}
        >
        {rows.length === 0 && answeredAsks.length === 0 && !busy ? (
          <div className="bot-chat-empty">
            <BotCharacterAvatar
              name={botName}
              agentId={agentId ?? sessionId}
              avatarUrl={contact?.avatarUrl}
              avatarColor={contact?.avatarColor}
              avatarEmoji={contact?.avatarEmoji}
              size={72}
            />
            <div className="bot-chat-empty__name">{botName}</div>
            {subtitle && <div className="bot-chat-empty__desc">{subtitle}</div>}
          </div>
        ) : (
          transcriptNodes
        )}

        {/* Plan 494 — pending AskUserQuestion renders as an in-chat card
            (assistant side); generic tool approvals render as a compact
            permission card. Both ride respondToPermission. The ask card
            hides once its id is in answeredAsks: the hook keeps the
            pending entry ~2s after a decision, and during that window the
            answered trace must not show next to the live card. The pending
            card renders AFTER all spliced answered traces — it is always
            the newest item in the flow. */}
        {pendingPermission && !answeredAsks.some((a) => a.id === pendingPermission.id) &&
          (isAskPending ? (
            <div
              className={`bot-chat-row${tailCardJoins ? " bot-chat-row--grouped" : ""} bot-chat-row--assistant`}
              data-role="assistant"
            >
              <BotAskCard
                request={pendingPermission}
                onSubmit={(updatedInput) => handleAskSubmit(pendingPermission, updatedInput)}
                t={t}
                className={tailCardJoins ? "bot-chat-bubble--group-end" : undefined}
              />
            </div>
          ) : (
            <div
              className={`bot-chat-row${tailCardJoins ? " bot-chat-row--grouped" : ""} bot-chat-row--assistant`}
              data-role="assistant"
            >
              <BotPermissionCard
                request={pendingPermission}
                onRespond={(decision, updatedInput, denyMessage) => void respondToPermission(decision, updatedInput, denyMessage)}
                t={t}
                className={tailCardJoins ? "bot-chat-bubble--group-end" : undefined}
              />
            </div>
          ))}

        {pendingAuthRequest && (
          <div
            className={`bot-chat-row${tailCardJoins ? " bot-chat-row--grouped" : ""} bot-chat-row--assistant`}
            data-role="assistant"
          >
            <ConnectorAuthRequiredCard
              request={pendingAuthRequest}
              authCompleted={authCompletedFor !== null && authCompletedFor === pendingAuthRequest.provider}
              onDismiss={dismissAuthRequest}
              onRetry={retryAfterAuth}
              resolveProviderLabel={(id) => id}
            />
          </div>
        )}

        {/* Rolling "current activity" line (Plan: bot-chat live activity):
            replaces the static typing pill - shows exactly what the bot is
            doing right now (thinking line / current tool), slides to the
            new line on every new tool call, hides once the bot streams its
            reply text. */}
        {busy && <BotActivityIndicator sessionId={sessionId} />}
        </div>

        {/* Bottom fade — dissolves the scroll boundary while scrolled up.
            Sibling of the scroll container: pinned to the visible bottom
            edge, never scrolls, and the jump button paints above it. */}
        {isScrolledUp && <div className="bot-chat-scroll-fade" aria-hidden="true" />}

        {/* Plan 491 P0.4: jump to latest — plain circle + chevron-down
            (2026-09-05 restyle: capsule + label replaced). */}
        {isScrolledUp && (
          <button
            className="bot-chat-jump-to-latest"
            onClick={() => {
              const el = transcriptRef.current;
              if (el) {
                el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
                setIsScrolledUp(false);
              }
            }}
            aria-label="Jump to latest"
          >
            <ChevronDownIcon size={16} strokeWidth={2} />
          </button>
        )}
      </div>

      <Composer
        key={sessionId}
        draftKey={sessionId}
        disabled={!canSendToBot}
        busy={busy}
        onSubmit={handleComposerSend}
        onStop={onStop}
        showPlus
        enableAttachments
        replyPreview={replyTarget}
        onClearReply={() => setReplyTarget(null)}
        contextRing={
          usageMessages.length > 0 ? (
            <ContextUsageRing
              variant="popup"
              messages={usageMessages}
              sessionId={sessionId}
              modelName={contact?.model}
              onCompress={handleCompact}
              isCompacting={isCompacting}
              reversed={settings.contextRingReversed ?? false}
            />
          ) : undefined
        }
        placeholder={
          canSendToBot
            ? t("bot.chat.placeholder", { name: botName })
            : t("bot.chat.placeholderUnbound")
        }
      />
    </div>
  );
}
