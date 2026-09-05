"use client";

/**
 * BotContactListItem — Telegram-style contact row for one bot in the
 * sidebar Bots section (plan 483 P1.2 + P2).
 *
 * Renders the character avatar (grok-style shape × color via
 * BotCharacterAvatar; deterministic-hue initial fallback for legacy
 * agents) + display name + a single WeChat-style second line: the
 * latest transcript message when the bound session has one, otherwise
 * the title/description fallback, plus a busy dot that rides the bound
 * session's stream phase
 * (`subscribeToPhase`, same source as ThreadListItem's running
 * indicator), the latest user-visible message preview
 * (`useBotDirectTranscript` + `peekBotMessagePreview`, plan 489 P0.3 +
 * 483 P1.4), and the bound session's relative activity time. Unbound
 * contacts (no persistent session yet, plan 477 pending) simply stay
 * idle and show no preview.
 *
 * Plan 483 P2 management surface, mirroring the thread-row pattern:
 *   - hover actions: quick pin toggle + "⋯" menu button
 *   - right-click / "⋯" menu: edit, pin/unpin, copy bot id, hide
 *     (or restore in the hidden view), delete
 *   - pinned contacts show a filled pin indicator; hidden contacts
 *     render dimmed with a restore affordance.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeToPhase } from "@/lib/stream-session-manager";
import type { StreamPhase } from "@/types/message";
import { useMailboxStore } from "@/stores/mailbox-store";
import { useBotActivityStore } from "@/stores/bot-activity-store";
import { useBotDirectTranscript } from "@/components/chat/bot/use-bot-direct-transcript";
import {
  ArchiveIcon,
  CopyIcon,
  DotsThreeIcon,
  EyeSlashIcon,
  NotePencilIcon,
  PinFilledIcon,
  PinIcon,
} from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";
import { Button } from "@/components/ui/Button";
import type { TranslationKey } from "@/i18n";
import { BotCharacterAvatar } from "./BotCharacterAvatar";
import {
  peekBotMessagePreview,
  type BotContact,
  type BotSessionStatus,
} from "./bot-contacts";

const ACTIVE_PHASES: StreamPhase[] = [
  "starting",
  "streaming",
  "awaiting_permission",
  "persisting",
];

type TFunc = (key: TranslationKey, params?: Record<string, string | number>) => string;

function formatTimeAgo(t: TFunc, timestamp: number): string {
  if (!timestamp) return "";
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  const weeks = Math.floor(diff / 604800000);

  if (minutes < 1) return t("time.justNow");
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  return `${weeks}w`;
}

interface BotContactListItemProps {
  contact: BotContact;
  isActive: boolean;
  onOpen: (contact: BotContact) => void;
  /** Plan 483 P2 management callbacks (optional — omitted in read-only contexts). */
  onTogglePin?: (agentId: string, isPinned: boolean) => void;
  onEdit?: (contact: BotContact) => void;
  onDelete?: (contact: BotContact) => void;
  onCopyId?: (contact: BotContact) => void;
  onHide?: (contact: BotContact) => void;
  onUnhide?: (contact: BotContact) => void;
  /** Hidden-view mode: render dimmed with a restore affordance instead of the normal actions. */
  restoreView?: boolean;
  /** Plan 483 P2: drag-to-reorder inside the pinned rail. */
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
}

export function BotContactListItem({
  contact,
  isActive,
  onOpen,
  onTogglePin,
  onEdit,
  onDelete,
  onCopyId,
  onHide,
  onUnhide,
  restoreView = false,
  draggable = false,
  onDragStart,
  onDragOver,
  onDrop,
}: BotContactListItemProps) {
  const { t } = useTranslation();
  const [showMenu, setShowMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Plan 483 P1.4 (2026-09-05): live activity for this bot row.
  // - `preview` is the latest user-visible message text in the bound
  //   session (mirrors grok-bot / rakazo's sidebar preview; same source
  //   filter as BotDirectChatView so the row matches what the user
  //   sees when they click in).
  // - `status` (`idle` / `running` / `queued`) replaces the old boolean
  //   `isBusy`. `running` rides the bound session's stream phase,
  //   `queued` flips on when the user submitted a follow-up while
  //   another run was active (mailbox.pending count > 0).
  const sessionId = contact.boundThreadId;
  const [phase, setPhase] = useState<StreamPhase>("idle");
  const markErrored = useBotActivityStore((s) => s.markErrored);
  const clearError = useBotActivityStore((s) => s.clearError);
  useEffect(() => {
    if (!sessionId) {
      setPhase("idle");
      return;
    }
    const unsubscribe = subscribeToPhase(sessionId, (next) => {
      setPhase(next);
      // Red badge lifecycle: a stream error lights the dot until the user
      // opens the bot (`markSeen`); a fresh run clears a stale one.
      if (next === "error") markErrored(contact.agentId);
      else if (next === "starting") clearError(contact.agentId);
    });
    return unsubscribe;
  }, [sessionId, contact.agentId, markErrored, clearError]);

  // Mailbox pending rows (plan 202). The store's `bySession` is a Map,
  // so we subscribe at the map reference and count rows lazily on each
  // mutation. `pending + queued` matches the renderer-visible "user
  // submitted a follow-up that is waiting for the active run to reach a
  // safe checkpoint" state.
  const mailboxBySession = useMailboxStore((s) => s.bySession);
  const queuedCount = (() => {
    if (!sessionId) return 0;
    const sessionMap = mailboxBySession.get(sessionId);
    if (!sessionMap) return 0;
    let count = 0;
    for (const row of sessionMap.values()) {
      if (row.status === "pending" && row.kind === "queued") count += 1;
    }
    return count;
  })();

  // Bot-direct transcript (plan 489 P0.3). This is the **primary** source
  // for the bound session's messages — NOT `useConversationStore`. The
  // conversation-store reflects the unfiltered workspace stream (tool /
  // thinking / scratchpad rows included); bot-direct sessions only ever
  // have user-typed + SendMessageTool + agent_dm marker rows persisted,
  // and `useBotDirectTranscript` is the hook that fetches + subscribes
  // to them. Without it, the sidebar preview was always `undefined` for
  // any bot the user had not already navigated into (the conversation
  // store only loads on `loadThreadMessages`, which fires on session
  // switch).
  const { messages: sessionMessages } = useBotDirectTranscript(sessionId);
  const previewSnapshot = peekBotMessagePreview(sessionMessages);

  const status: BotSessionStatus = (() => {
    if (!sessionId) return "idle";
    if (ACTIVE_PHASES.includes(phase)) return "running";
    if (queuedCount > 0) return "queued";
    return "idle";
  })();
  const activeIsBusy = status === "running";

  // WeChat-style avatar badges (green = finished but unseen, red = errored).
  // Unseen derives from the transcript's last message timestamp vs the
  // persisted last-open stamp; badges only show while the bot is idle (a
  // running ring takes over while it works). Opening the bot stamps seen
  // and clears the error.
  const lastSeenAt = useBotActivityStore((s) => s.lastSeenAt[contact.agentId]);
  const erroredAt = useBotActivityStore((s) => s.erroredAt[contact.agentId]);
  const markSeen = useBotActivityStore((s) => s.markSeen);
  const hasUnseen =
    status === "idle" &&
    previewSnapshot != null &&
    previewSnapshot.timestamp > (lastSeenAt ?? 0);
  const hasError = status === "idle" && erroredAt != null;
  // While the bot's chat is the active view, keep stamping seen on every
  // new message — otherwise a run that completes in-view would light the
  // green dot for a transcript the user is literally watching.
  const lastMsgTs = previewSnapshot?.timestamp ?? 0;
  useEffect(() => {
    if (isActive && sessionId) markSeen(contact.agentId);
  }, [isActive, sessionId, contact.agentId, markSeen, lastMsgTs]);

  const subtitle = contact.title || contact.description;
  const rowTitle = previewSnapshot?.text || subtitle || contact.name;
  const isPinned = contact.isPinned === true;
  const isHidden = contact.isHidden === true;

  // Close menu on outside click.
  useEffect(() => {
    if (!showMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showMenu]);

  const openMenuAt = useCallback((x: number, y: number) => {
    const menuWidth = 200;
    const menuHeight = 240;
    let px = x;
    let py = y;
    if (px + menuWidth > window.innerWidth) px = window.innerWidth - menuWidth - 8;
    if (py + menuHeight > window.innerHeight) py = window.innerHeight - menuHeight - 8;
    setMenuPos({ x: px, y: py });
    setShowMenu(true);
  }, []);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      openMenuAt(e.clientX, e.clientY);
    },
    [openMenuAt],
  );

  const handleMenuClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (buttonRef.current) {
        const rect = buttonRef.current.getBoundingClientRect();
        openMenuAt(rect.right - 200, rect.bottom + 4);
      } else {
        openMenuAt(e.clientX, e.clientY);
      }
    },
    [openMenuAt],
  );

  const closeMenu = () => setShowMenu(false);

  const handleOpen = () => {
    closeMenu();
    onOpen(contact);
  };

  const handleTogglePin = () => {
    closeMenu();
    onTogglePin?.(contact.agentId, !isPinned);
  };

  const handleCopyId = () => {
    closeMenu();
    void navigator.clipboard.writeText(contact.agentId);
    onCopyId?.(contact);
  };

  const handleEdit = () => {
    closeMenu();
    onEdit?.(contact);
  };

  const handleHide = () => {
    closeMenu();
    onHide?.(contact);
  };

  const handleUnhide = () => {
    closeMenu();
    onUnhide?.(contact);
  };

  const handleDelete = () => {
    closeMenu();
    onDelete?.(contact);
  };

  const body = (
    <>
      <span
        className={`bot-contact-avatar-wrap${activeIsBusy ? " running" : ""}`}
      >
        <BotCharacterAvatar
          name={contact.name}
          agentId={contact.agentId}
          avatarUrl={contact.avatarUrl}
          avatarColor={contact.avatarColor}
          size={26}
        />
        {hasError ? (
          <span
            className="bot-contact-badge error"
            title={t("bot.contactBadgeError")}
          />
        ) : hasUnseen ? (
          <span
            className="bot-contact-badge unseen"
            title={t("bot.contactBadgeUnseen")}
          />
        ) : null}
      </span>
      <span className="bot-contact-body">
        <span className="bot-contact-name">
          {isPinned && <PinFilledIcon size={10} className="bot-contact-pin-indicator" />}
          {contact.name}
        </span>
        {/* WeChat-style second line: the latest transcript message wins;
            the title/description only shows for bots with no messages yet. */}
        {previewSnapshot ? (
          <span
            className="bot-contact-desc bot-contact-preview"
            title={previewSnapshot.text}
          >
            {previewSnapshot.text}
          </span>
        ) : (
          subtitle && <span className="bot-contact-desc">{subtitle}</span>
        )}
      </span>
      <span className="bot-contact-trailing">
        {status === "queued" ? (
          <span
            className="bot-contact-status-pill queued"
            title={t("bot.contactStatus.queued")}
          >
            {t("bot.contactStatus.queued")}
          </span>
        ) : (
          <span className="bot-contact-time">{formatTimeAgo(t, contact.lastActivity)}</span>
        )}
      </span>
    </>
  );

  // Hidden-view: dimmed row with an explicit restore button.
  if (restoreView || isHidden) {
    return (
      <div
        className={`bot-contact-item hidden${isActive ? " active" : ""}`}
        title={rowTitle}
        role="button"
        tabIndex={0}
        onClick={handleOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleOpen();
          }
        }}
      >
        {body}
        <button
          type="button"
          className="bot-contact-restore-btn"
          onClick={(e) => {
            e.stopPropagation();
            handleUnhide();
          }}
          title={t("bot.actions.restore")}
          aria-label={t("bot.actions.restore")}
        >
          <EyeSlashIcon size={14} />
        </button>
      </div>
    );
  }

  return (
    <>
      <div
        className={`bot-contact-item${isActive ? " active" : ""}`}
        onClick={handleOpen}
        onContextMenu={handleContextMenu}
        title={rowTitle}
        role="button"
        tabIndex={0}
        draggable={draggable || undefined}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleOpen();
          } else if (e.key === "Escape") {
            setShowMenu(false);
          }
        }}
      >
        {body}
        <div className={`bot-contact-actions-hover${showMenu ? " open" : ""}`}>
          {onTogglePin && (
            <button
              type="button"
              className="bot-contact-pin-btn"
              onClick={(e) => {
                e.stopPropagation();
                handleTogglePin();
              }}
              aria-label={isPinned ? t("bot.actions.unpin") : t("bot.actions.pin")}
              title={isPinned ? t("bot.actions.unpin") : t("bot.actions.pin")}
            >
              {isPinned ? <PinFilledIcon size={14} /> : <PinIcon size={14} />}
            </button>
          )}
          <button
            ref={buttonRef}
            type="button"
            className="bot-contact-menu-btn"
            onClick={handleMenuClick}
            aria-label={t("bot.actions.options")}
          >
            <DotsThreeIcon size={16} stroke={2.5} />
          </button>
        </div>
      </div>

      {/* Dropdown Menu */}
      {showMenu && (
        <div
          ref={menuRef}
          className="bot-dropdown-menu"
          style={{ top: menuPos.y, left: menuPos.x }}
        >
          {onEdit && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="bot-dropdown-item"
              onClick={handleEdit}
            >
              <NotePencilIcon size={14} />
              <span>{t("bot.actions.edit")}</span>
            </Button>
          )}
          {onTogglePin && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="bot-dropdown-item"
              onClick={handleTogglePin}
            >
              {isPinned ? <PinFilledIcon size={14} /> : <PinIcon size={14} />}
              <span>{isPinned ? t("bot.actions.unpin") : t("bot.actions.pin")}</span>
            </Button>
          )}
          {onCopyId && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="bot-dropdown-item"
              onClick={handleCopyId}
            >
              <CopyIcon size={14} />
              <span>{t("bot.actions.copyId")}</span>
            </Button>
          )}
          {onHide && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="bot-dropdown-item"
              onClick={handleHide}
            >
              <EyeSlashIcon size={14} />
              <span>{t("bot.actions.hide")}</span>
            </Button>
          )}
          {onDelete && (
            <>
              <div className="bot-dropdown-divider" />
              <Button
                type="button"
                variant="danger"
                size="sm"
                className="bot-dropdown-item danger"
                onClick={handleDelete}
              >
                <ArchiveIcon size={14} />
                <span>{t("bot.actions.delete")}</span>
              </Button>
            </>
          )}
        </div>
      )}
    </>
  );
}
