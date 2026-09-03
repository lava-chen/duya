"use client";

/**
 * BotContactListItem — Telegram-style contact row for one bot in the
 * sidebar Bots section (plan 483 P1.2 + P2).
 *
 * Renders the character avatar (grok-style shape × color via
 * BotCharacterAvatar; deterministic-hue initial fallback for legacy
 * agents) + display name + subtitle (title, else description), a busy
 * dot that rides the bound session's stream phase
 * (`subscribeToPhase`, same source as ThreadListItem's running
 * indicator), and the bound session's relative activity time. Unbound
 * contacts (no persistent session yet, plan 477 pending) simply stay
 * idle.
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
import type { BotContact } from "./bot-contacts";

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
  const [isBusy, setIsBusy] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!contact.boundThreadId) {
      setIsBusy(false);
      return;
    }
    const unsubscribe = subscribeToPhase(contact.boundThreadId, (phase) => {
      setIsBusy(ACTIVE_PHASES.includes(phase));
    });
    return unsubscribe;
  }, [contact.boundThreadId]);

  const subtitle = contact.title || contact.description;
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
      <BotCharacterAvatar
        name={contact.name}
        agentId={contact.agentId}
        avatarShape={contact.avatarShape}
        avatarColor={contact.avatarColor}
        size={26}
      />
      <span className="bot-contact-body">
        <span className="bot-contact-name">
          {isPinned && <PinFilledIcon size={10} className="bot-contact-pin-indicator" />}
          {contact.name}
        </span>
        {subtitle && <span className="bot-contact-desc">{subtitle}</span>}
      </span>
      <span className="bot-contact-trailing">
        {isBusy ? (
          <span
            className="bot-contact-busy-dot"
            title={t("bot.contactBusy")}
            aria-label={t("bot.contactBusy")}
          />
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
        title={subtitle || contact.name}
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
        title={subtitle || contact.name}
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
