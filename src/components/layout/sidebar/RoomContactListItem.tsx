"use client";

/**
 * RoomContactListItem — sidebar row for one shared room (Plan 478 P3.1).
 * Reuses the BotContactListItem row chrome (`bot-contact-item`) with a
 * composite room avatar (rakazo group-avatar parity) and a member-names
 * preview line; the trailing pencil opens the group settings dialog.
 */

import React from "react";
import { NotePencilIcon } from "@/components/icons";
import { BotCharacterAvatar } from "./BotCharacterAvatar";
import type { RoomContact } from "./bot-contacts";

export interface RoomContactListItemProps {
  room: RoomContact;
  isActive: boolean;
  onOpen: () => void;
  onEdit: () => void;
}

export function RoomContactListItem({
  room,
  isActive,
  onOpen,
  onEdit,
}: RoomContactListItemProps) {
  const preview =
    room.memberNames.length > 0
      ? room.memberNames.join(", ")
      : `${room.memberIds.length} 名成员`;

  return (
    <div
      className={`bot-contact-item${isActive ? " active" : ""}`}
      data-testid={`room-contact-${room.roomId}`}
      title={preview}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <span className="bot-contact-avatar-wrap">
        <RoomGroupAvatar room={room} size={26} />
      </span>
      <span className="bot-contact-body">
        <span className="bot-contact-name">{room.name}</span>
        <span className="bot-contact-desc bot-contact-preview">{preview}</span>
      </span>
      <span className="bot-contact-trailing">
        <button
          type="button"
          className="bot-contact-menu-btn"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          aria-label="群聊设置"
          data-testid={`room-settings-${room.roomId}`}
        >
          <NotePencilIcon size={14} />
        </button>
      </span>
    </div>
  );
}

/**
 * Composite room avatar (rakazo group-avatar parity, simplified): 1 member →
 * plain bot avatar; 2 → overlapping pair; 3+ → two avatars + overflow badge.
 */
function RoomGroupAvatar({ room, size }: { room: RoomContact; size: number }) {
  const members = room.memberIds;
  if (members.length <= 1) {
    return (
      <span
        className="flex items-center justify-center rounded-full bg-[var(--bg-hover)] text-[13px] font-semibold text-[var(--text-muted)]"
        style={{ width: size, height: size }}
      >
        #
      </span>
    );
  }
  const [firstId, secondId] = members;
  const firstName = room.memberNames[0] ?? firstId ?? "";
  const secondName = room.memberNames[1] ?? secondId ?? "";
  const mini = Math.round(size * 0.62);
  return (
    <span className="relative inline-block" style={{ width: size, height: size }} aria-hidden>
      {firstId && (
        <span className="absolute left-0 top-0 rounded-full" style={{ boxShadow: "0 0 0 1.5px var(--bg-canvas, #fff)" }}>
          <BotCharacterAvatar name={firstName} agentId={firstId} size={mini} />
        </span>
      )}
      {secondId && (
        <span className="absolute bottom-0 right-0 rounded-full" style={{ boxShadow: "0 0 0 1.5px var(--bg-canvas, #fff)" }}>
          <BotCharacterAvatar name={secondName} agentId={secondId} size={mini} />
        </span>
      )}
      {members.length > 2 && (
        <span
          className="absolute bottom-0 right-0 z-10 flex items-center justify-center rounded-full bg-[var(--bg-hover)] text-[9px] font-semibold text-[var(--text-muted)]"
          style={{ width: mini, height: mini, boxShadow: "0 0 0 1.5px var(--bg-canvas, #fff)" }}
        >
          +{members.length - 2}
        </span>
      )}
    </span>
  );
}
