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
import { BotComposer, type BotComposerSendPayload } from "./BotComposer";
import { BotBubbleRow } from "./BotBubbleRow";
import { BotToolCallRow } from "./BotToolCallRow";
import { BotThinkingRow } from "./BotThinkingRow";
import { BotTypingIndicator } from "./BotTypingIndicator";
import { AgentDmGroupChip } from "./bot/AgentDmGroupChip";
import {
  buildAgentDmChipGroups,
  isAgentDmMarkerMessage,
  type AgentDmChipGroup,
} from "./bot/agent-dm-pair";
import { isBotDirectVisibleSource } from "@/lib/ipc-client";
import { ChevronDownIcon } from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";
import type { Message } from "@/types/message";

import { useBotContacts } from "@/components/layout/sidebar/use-bot-contacts";
import { useOptionalPanel } from "@/hooks/usePanel";
import { BotCharacterAvatar } from "@/components/layout/sidebar/BotCharacterAvatar";
import { resolveBotAgentId } from "./bot/chat-mode";
import { useBotDirectTranscript } from "./bot/use-bot-direct-transcript";
import {
  loadBotModelPreference,
  saveBotModelPreference,
  type BotModelPreference,
} from "./bot/model-preference";
import { mergeInFlightOptimisticMessages } from "@/stores/conversation-store";
import {
  BotMessageHoverBar,
  BotThumbsBadge,
  useMessageThumbsUp,
} from "./BotMessageHoverBar";
import { BotSendCard } from "./BotSendCard";
import { splitReplyContent, isReplyContent, type ReplyQuote } from "./bot/reply";
// Plan 494: bot-direct renders its own permission/ask cards — ChatView
// (and its PermissionPrompt sheet) is not mounted in this mode.
import { usePermissions } from "@/hooks/usePermissions";
import { subscribeToPermissions } from "@/lib/stream-session-manager";
import type { PermissionRequestEvent } from "@/types/stream";
import { BotAskCard } from "./bot/BotAskCard";
import { BotPermissionCard } from "./bot/BotPermissionCard";

export interface BotDirectChatViewProps {
  sessionId: string;
  messages: Message[];
  isStreaming: boolean;
  isFinalizing: boolean;
  onSend: (payload: BotComposerSendPayload) => void;
  onStop: () => void;
  /** Plan 497: open a DM pair as a full sibling view (App owns the state;
   *  absent → chips render but stay inert, e.g. standalone test renders). */
  onOpenDmPair?: (peerId: string, peerName: string) => void;
}

/** Calendar-day key for grouping messages under date separators. */
function dayKeyOf(timestamp: number): string {
  return new Date(timestamp).toDateString();
}

/** Separator label: locale date, year omitted when current. */
function dateSeparatorLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  return date.getFullYear() === now.getFullYear()
    ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
    : new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
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
  if (
    type === 'attachment' ||
    type === 'widget' ||
    type === 'cursor-agent' ||
    type === 'secret-request'
  ) {
    return true;
  }
  // Plain text with re-attached images renders text + image strip.
  return type === 'text' && !!message.sendMessageMeta?.images?.length;
}

function SendCardRow({
  message,
  onOptionClick,
  onReply,
}: {
  message: Message;
  onOptionClick?: (option: string) => void;
  onReply?: () => void;
}) {
  const [thumbsUp, toggleThumbsUp] = useMessageThumbsUp(message.id);
  return (
    <div className="bot-chat-row bot-chat-row--assistant" data-role="assistant">
      <div className="bot-chat-row__stack">
        <div className="bot-chat-bubble bot-chat-bubble--assistant bot-chat-bubble--card">
          <BotSendCard message={message} onOptionClick={onOptionClick} />
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
function AnsweredAskRow({ ask }: { ask: AnsweredAsk }) {
  return (
    <div className="bot-chat-row bot-chat-row--assistant" data-role="assistant">
      <div className="bot-ask-card bot-ask-card--answered" data-permission-id={ask.id}>
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
  const { openOrActivatePage } = useOptionalPanel() ?? { openOrActivatePage: null };
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
  const { messages: persistedTranscript } = useBotDirectTranscript(sessionId);
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

  // Persisted per-bot model/effort preference (localStorage). Loaded on mount /
  // session switch; every pick is written back so the choice survives reloads.
  const [modelPref, setModelPref] = useState<BotModelPreference | null>(null);
  useEffect(() => {
    setModelPref(loadBotModelPreference(sessionId));
  }, [sessionId]);

  const handleBotModelChange = useCallback((model: string, providerId?: string) => {
    setModelPref((prev) => {
      const next = { model, providerId, effort: prev?.effort };
      saveBotModelPreference(sessionId, next);
      return { ...next, updatedAt: Date.now() };
    });
  }, [sessionId]);

  const handleBotEffortChange = useCallback((effort: string | undefined) => {
    setModelPref((prev) => {
      const next = { model: prev?.model ?? '', providerId: prev?.providerId, effort };
      saveBotModelPreference(sessionId, next);
      return { ...next, updatedAt: Date.now() };
    });
  }, [sessionId]);

  const botName = contact?.name ?? agentId ?? sessionId;
  const subtitle = contact?.title || contact?.description || "";
  // Plan 491 P1.2 / 477 P3.1: the persistent bot session is now lazily
  // created server-side on first send (`session:ensureBot`), so a 2-part
  // placeholder id (`bot:<agentId>`) is directly sendable — the old
  // boundThreadId (3-part) requirement permanently disabled the composer.
  // The bot only needs to exist in the configured roster.
  const canSendToBot = contact != null;
  const busy = isStreaming || isFinalizing;

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
    return subscribeToPermissions(sessionId, handlePermissionRequest);
  }, [sessionId, handlePermissionRequest]);

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
      if (message.isTaskNotification) continue;
      // Plan 497 — defense-in-depth mirror of the ingestion filter (App's
      // message:new handler): hidden-source rows (wake prompts, tool_use,
      // scratchpad, …) never render, even if a stale store still holds one.
      if (message.source != null && !isBotDirectVisibleSource(message.source)) {
        continue;
      }
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
        // still renders — as a card with just the image strip.
        const hasCardImages =
          message.role === 'assistant' && !!message.sendMessageMeta?.images?.length;
        if (!text.trim() && !hasCardImages) continue;
        result.push({
          message,
          role: message.role,
          text,
          isGroupStart: previousRole !== message.role,
          replyPreview,
          // Card rows render their own chrome — grouping candidates are
          // plain text/reply bubbles only (a card breaks the visual group).
          isBubbleRow: !isSendCardMessage(message),
        });
        previousRole = message.role;
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
        dayKeyOf(prev.message.timestamp) === dayKeyOf(row.message.timestamp);
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
  // their chronological anchor (plan 494).
  const renderRow = useCallback(
    (row: BubbleRow, index: number): React.ReactNode => {
      // Date separator before the first row of each calendar day
      // (grok sand-transcript-time-separator). Rows with an invalid
      // timestamp (NaN/undefined) must not reach Intl.format — it
      // throws RangeError and takes down the whole transcript render
      // — so such rows are skipped instead.
      const previous = rows[index - 1];
      const showSeparator =
        Number.isFinite(row.message.timestamp) &&
        (previous == null ||
          dayKeyOf(previous.message.timestamp) !== dayKeyOf(row.message.timestamp));
      const element = isSendCardMessage(row.message) ? (
        <SendCardRow
          key={row.message.id}
          message={row.message}
          onOptionClick={(option) => onSend({ text: option })}
          onReply={() => handleReply(row)}
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
          groupPosition={row.groupPosition}
        />
      ) : (
        <StatusRow key={row.message.id} message={row.message} />
      );
      return showSeparator ? (
        <React.Fragment key={row.message.id}>
          <div className="bot-chat-date-separator" role="separator">
            {dateSeparatorLabel(row.message.timestamp)}
          </div>
          {element}
        </React.Fragment>
      ) : (
        element
      );
    },
    [rows, onSend, handleReply, jumpToMessage, contacts, contactNames],
  );

  // Interleave answered-ask traces into the transcript at their submit-time
  // anchor so a trace sits BETWEEN the messages around its question — a new
  // pending ask must always appear AFTER older answered cards (plan 494
  // ordering fix).
  const transcriptNodes = useMemo<React.ReactNode[]>(() => {
    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    for (const ask of answeredAsks) {
      const anchor = Math.min(ask.anchor, rows.length);
      for (let i = cursor; i < anchor; i++) nodes.push(renderRow(rows[i], i));
      nodes.push(<AnsweredAskRow key={ask.id} ask={ask} />);
      cursor = anchor;
    }
    for (let i = cursor; i < rows.length; i++) nodes.push(renderRow(rows[i], i));
    return nodes;
  }, [rows, answeredAsks, renderRow]);

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

  // Composer send: attach the active reply target (App composes it into
  // the outgoing content) and clear the chip, rakazo send parity.
  const handleComposerSend = useCallback(
    (payload: BotComposerSendPayload) => {
      onSend({
        ...payload,
        replyTo: replyTarget ?? undefined,
      });
      setReplyTarget(null);
    },
    [onSend, replyTarget],
  );



  return (
    <div className="bot-chat-view">
      <header className="bot-chat-header">
        <button
          type="button"
          className="bot-chat-header__identity"
          title={subtitle || undefined}
          onClick={() => {
            if (!contact || !openOrActivatePage) return;
            openOrActivatePage("bot-settings", {
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
              size={28}
            />
          </span>
          <span className="bot-chat-header__name">{botName}</span>
        </button>
        {busy && <small className="bot-chat-header__working">{t("bot.chat.working")}</small>}
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
            <div className="bot-chat-row bot-chat-row--assistant" data-role="assistant">
              <BotAskCard
                request={pendingPermission}
                onSubmit={(updatedInput) => handleAskSubmit(pendingPermission, updatedInput)}
                t={t}
              />
            </div>
          ) : (
            <div className="bot-chat-row bot-chat-row--assistant" data-role="assistant">
              <BotPermissionCard request={pendingPermission} onRespond={(decision, updatedInput, denyMessage) => void respondToPermission(decision, updatedInput, denyMessage)} t={t} />
            </div>
          ))}

        {busy && <BotTypingIndicator />}
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

      <BotComposer
        key={sessionId}
        botId={sessionId}
        disabled={!canSendToBot}
        busy={busy}
        onSend={handleComposerSend}
        onStop={onStop}
        replyPreview={replyTarget}
        onClearReply={() => setReplyTarget(null)}
        initialModel={modelPref?.model}
        initialProviderId={modelPref?.providerId}
        initialEffort={modelPref?.effort}
        onModelChange={handleBotModelChange}
        onEffortChange={handleBotEffortChange}
        placeholder={
          canSendToBot
            ? t("bot.chat.placeholder")
            : t("bot.chat.placeholderUnbound")
        }
      />
    </div>
  );
}
