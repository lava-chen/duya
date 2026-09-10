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
import {
  subscribeToPhase,
  subscribeToPermissions,
  subscribeToConnectorAuthRequired,
  type ConnectorAuthRequiredData,
} from "@/lib/stream-session-manager";
import { createPortal } from "react-dom";
import type { StreamPhase } from "@/types/message";
import type { PermissionRequestEvent } from "@/types/stream";
import { useMailboxStore } from "@/stores/mailbox-store";
import { useBotActivityStore } from "@/stores/bot-activity-store";
import { useBotDirectTranscript } from "@/components/chat/bot/use-bot-direct-transcript";
import {
  ArchiveIcon,
  CaretRightIcon,
  CopyIcon,
  DotsThreeIcon,
  EyeSlashIcon,
  FolderIcon,
  NotePencilIcon,
  PinFilledIcon,
  PinIcon,
  PlusIcon,
  XIcon,
} from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";
import { Button } from "@/components/ui/Button";
import { InputDialog } from "@/components/ui/InputDialog";
import type { TranslationKey } from "@/i18n";
import { BotCharacterAvatar } from "./BotCharacterAvatar";
import {
  peekBotMessagePreview,
  type BotContact,
  type BotSectionDef,
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
  /** Sidebar groups (sections) for the "Move to" submenu. */
  sections?: BotSectionDef[];
  /** The section this bot currently belongs to, or null/undefined when unassigned. */
  currentSectionId?: string | null;
  onMoveToSection?: (agentId: string, toSectionId: string | null) => void;
  /** Create a new section and move this bot into it in one shot. */
  onCreateSection?: (agentId: string) => void;
  /** Hidden-view mode: render dimmed with a restore affordance instead of the normal actions. */
  restoreView?: boolean;
  /** Plan 483 P2: drag-to-reorder inside the pinned rail. */
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
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
  sections = [],
  currentSectionId,
  onMoveToSection,
  onCreateSection,
  restoreView = false,
  draggable = false,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: BotContactListItemProps) {
  const { t } = useTranslation();
  const [showMenu, setShowMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // "Move to" cascading submenu (mirrors ProjectGroupItem's section
  // submenu): flips left when the parent menu would push it past the
  // right viewport edge.
  const [submenuFlipLeft, setSubmenuFlipLeft] = useState(false);
  const [sectionSubmenuOpen, setSectionSubmenuOpen] = useState(false);
  const sectionMenuRef = useRef<HTMLDivElement>(null);
  const [isNewSectionDialogOpen, setIsNewSectionDialogOpen] = useState(false);

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

  // Plan 516 — "waiting on user" trailing pill. The bound session is
  // paused on a permission request (AskUserQuestion, generic tool
  // approval, or connector auth). The shared StreamSessionManager
  // already publishes these into pendingPermissionRequest /
  // pendingConnectorAuthRequest and pushes them via the same subscribeTo*
  // APIs that BotDirectChatView uses to render the cards (plan 494 +
  // 503). We just mirror the latest event into local state so the row
  // can show a pill regardless of which view the user is in.
  // Priority in the trailing slot: awaiting-input > queued > time.
  type AwaitingInputKind = 'ask' | 'permission' | 'auth';
  const [awaitingInput, setAwaitingInput] = useState<AwaitingInputKind | null>(null);
  useEffect(() => {
    if (!sessionId) {
      setAwaitingInput(null);
      return;
    }
    const unsubPerm = subscribeToPermissions(sessionId, (request: PermissionRequestEvent) => {
      // AskUserQuestion takes precedence over generic tool approvals:
      // both arrive on the same channel, but the user expects the
      // "answer this question" pill over a background approval badge.
      if (request == null) {
        setAwaitingInput(null);
        return;
      }
      const kind: AwaitingInputKind =
        request.toolName === 'AskUserQuestion' || request.mode === 'ask_user_question'
          ? 'ask'
          : 'permission';
      setAwaitingInput(kind);
    });
    const unsubAuth = subscribeToConnectorAuthRequired(sessionId, (data: ConnectorAuthRequiredData | null) => {
      setAwaitingInput(data ? 'auth' : null);
    });
    return () => {
      unsubPerm();
      unsubAuth();
    };
  }, [sessionId]);

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
  // Plan 483 P1.4 follow-up: the loading ring must light up for ANY bot
  // genuinely running a turn — including in the background. Two signals,
  // unioned:
  //   - the reactive phase subscription (`process`-level, fires the instant
  //     this bot's bound session crosses into an active phase, regardless of
  //     which view is focused), and
  //   - the roster's coarse status (`contact.status`, derived from
  //     `canSend` in use-bot-contacts). It polls at 2s, so it catches a
  //     run that started via the main process (wake / scheduled /
  //     send-to-agent) before the renderer attached to the live stream.
  // `canSend === false` only while a stream is truly live, so the ring can
  // never light up for an idle bot — it appears iff the bot is working.
  const isWorking = status === "running" || contact.status === "running";
  const activeIsBusy = isWorking;

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

  const subtitle = contact.description;
  const rowTitle = previewSnapshot?.text || subtitle || contact.title || contact.name;
  const isPinned = contact.isPinned === true;
  const isHidden = contact.isHidden === true;

  // Close menu on outside click.
  useEffect(() => {
    if (!showMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      const inMainMenu = menuRef.current?.contains(e.target as Node);
      const inSubMenu = sectionMenuRef.current?.contains(e.target as Node);
      if (!inMainMenu && !inSubMenu) {
        setShowMenu(false);
        setSectionSubmenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showMenu]);

  const openMenuAt = useCallback((x: number, y: number) => {
    const menuWidth = 200;
    const menuHeight = 300;
    let px = x;
    let py = y;
    if (px + menuWidth > window.innerWidth) px = window.innerWidth - menuWidth - 8;
    if (py + menuHeight > window.innerHeight) py = window.innerHeight - menuHeight - 8;
    // Flip the cascading "Move to" submenu when the parent menu sits in
    // the right gutter (mirrors ProjectGroupItem's submenu overflow guard).
    const SUBMENU_MIN_WIDTH = 180;
    const SUBMENU_GUTTER = 12;
    setSubmenuFlipLeft(
      px + menuWidth + SUBMENU_MIN_WIDTH + SUBMENU_GUTTER > window.innerWidth,
    );
    setMenuPos({ x: px, y: py });
    setSectionSubmenuOpen(false);
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

  // ─── "Move to" section actions (mirrors ProjectGroupItem) ───
  const closeAllMenus = useCallback(() => {
    setShowMenu(false);
    setSectionSubmenuOpen(false);
  }, []);

  const handleNewSection = useCallback(() => {
    closeAllMenus();
    // The parent owns the create-and-move transaction: it opens the
    // shared new-group dialog and moves this bot in on confirm.
    onCreateSection?.(contact.agentId);
  }, [closeAllMenus, contact.agentId, onCreateSection]);

  const handleMoveToSection = useCallback(
    (sectionId: string | null) => {
      closeAllMenus();
      onMoveToSection?.(contact.agentId, sectionId);
    },
    [contact.agentId, onMoveToSection, closeAllMenus],
  );

  // Submenu hover intent: a brief delay on leave so a diagonal move does
  // not collapse the cascading submenu (mirrors ProjectGroupItem).
  const submenuHoverIntent = useRef<number | null>(null);
  const handleSubmenuEnter = useCallback(() => {
    if (submenuHoverIntent.current) {
      window.clearTimeout(submenuHoverIntent.current);
      submenuHoverIntent.current = null;
    }
    setSectionSubmenuOpen(true);
  }, []);
  const handleSubmenuLeave = useCallback(() => {
    if (submenuHoverIntent.current) {
      window.clearTimeout(submenuHoverIntent.current);
    }
    submenuHoverIntent.current = window.setTimeout(() => {
      setSectionSubmenuOpen(false);
      submenuHoverIntent.current = null;
    }, 200);
  }, []);
  useEffect(() => {
    return () => {
      if (submenuHoverIntent.current) window.clearTimeout(submenuHoverIntent.current);
    };
  }, []);

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
      <span className="bot-contact-avatar-wrap">
        <BotCharacterAvatar
          name={contact.name}
          agentId={contact.agentId}
          avatarUrl={contact.avatarUrl}
          avatarColor={contact.avatarColor}
          avatarEmoji={contact.avatarEmoji}
          size={32}
          working={activeIsBusy}
        />
        {activeIsBusy ? (
          <span
            className="bot-contact-running-ring"
            title={t("bot.contactStatus.running")}
            aria-label={t("bot.contactStatus.running")}
          />
        ) : hasError ? (
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
        <span className="bot-contact-head">
          <span className="bot-contact-name">
            {isPinned && <PinFilledIcon size={10} className="bot-contact-pin-indicator" />}
            {contact.name}
            {contact.title && (
              <span className="bot-contact-title-tag" title={contact.title}>
                {contact.title}
              </span>
            )}
          </span>
          <span className="bot-contact-trailing">
            {/* Plan 516 — awaiting-input pill wins over queued and time. The
                bound session is paused on a user-visible request, so the
                pill text identifies what the user needs to do (answer a
                question, approve a tool, finish connecting an app). */}
            {awaitingInput != null ? (
              <span
                className="bot-contact-status-pill awaiting-input"
                title={t(
                  awaitingInput === 'ask'
                    ? 'bot.contactStatus.awaitingAnswer'
                    : awaitingInput === 'auth'
                      ? 'bot.contactStatus.awaitingAuth'
                      : 'bot.contactStatus.awaitingPermission',
                )}
              >
                {t(
                  awaitingInput === 'ask'
                    ? 'bot.contactStatus.awaitingAnswer'
                    : awaitingInput === 'auth'
                      ? 'bot.contactStatus.awaitingAuth'
                      : 'bot.contactStatus.awaitingPermission',
                )}
              </span>
            ) : status === "queued" ? (
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
        </span>
        {/* Compact two-line roster row: name + time share the top line,
            the latest message preview (or role subtitle) sits below. */}
        {previewSnapshot ? (
          <span className="bot-contact-preview" title={previewSnapshot.text}>
            {previewSnapshot.text}
          </span>
        ) : (
          subtitle && (
            <span className="bot-contact-desc" title={subtitle}>
              {subtitle}
            </span>
          )
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
        onDragEnd={onDragEnd}
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

      {/* Dropdown Menu — portaled to <body> so the sidebar's backdrop-filter /
          overflow-hidden context (a containing block for `position: fixed`)
          can't clip the cascading "Move to" submenu at the sidebar's edge. */}
      {showMenu &&
        createPortal(
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
          {(onMoveToSection || onCreateSection) && (
            <div
              className="project-dropdown-section-row"
              onMouseEnter={handleSubmenuEnter}
              onMouseLeave={handleSubmenuLeave}
            >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="bot-dropdown-item project-dropdown-item-with-caret"
                onClick={() => setSectionSubmenuOpen((p) => !p)}
                aria-expanded={sectionSubmenuOpen}
              >
                <FolderIcon size={14} />
                <span>{t("bot.actions.moveTo")}</span>
                <CaretRightIcon
                  size={12}
                  className="ml-auto"
                  style={submenuFlipLeft ? { transform: "scaleX(-1)" } : undefined}
                />
              </Button>
              {sectionSubmenuOpen && (
                <div
                  ref={sectionMenuRef}
                  className={`project-dropdown-submenu${submenuFlipLeft ? " project-dropdown-submenu-flip-left" : ""}`}
                  onMouseEnter={handleSubmenuEnter}
                  onMouseLeave={handleSubmenuLeave}
                >
                  {onCreateSection && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="project-dropdown-item"
                      onClick={handleNewSection}
                      data-section-action="new"
                    >
                      <PlusIcon size={14} />
                      <span>{t("sidebar.section.newSection")}</span>
                    </Button>
                  )}
                  {onMoveToSection && sections.length > 0 && (
                    <div className="project-dropdown-divider" />
                  )}
                  {onMoveToSection &&
                    sections.map((section) => (
                      <Button
                        key={section.id}
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={`project-dropdown-item project-dropdown-item-checkable ${
                          section.id === currentSectionId ? "is-current" : ""
                        }`}
                        onClick={() => handleMoveToSection(section.id)}
                        data-section-id={section.id}
                      >
                        <FolderIcon size={14} />
                        <span>{section.name}</span>
                      </Button>
                    ))}
                  {onMoveToSection && currentSectionId && (
                    <>
                      <div className="project-dropdown-divider" />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="project-dropdown-item danger"
                        onClick={() => handleMoveToSection(null)}
                      >
                        <XIcon size={14} />
                        <span>{t("sidebar.section.removeFromSection")}</span>
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
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
        </div>,
          document.body,
        )}
    </>
  );
}
