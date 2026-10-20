"use client";

/**
 * RoomContactListItem — sidebar row for one shared room (Plan 478 P3.1).
 * Reuses the BotContactListItem row chrome (`bot-contact-item`) with a
 * composite room avatar (rakazo group-avatar parity) and a member-names
 * preview line; the trailing pencil opens the group settings dialog.
 */

import React from "react";
import { NotePencilIcon } from "@/components/icons";
import { GroupCompositeAvatar } from "@/components/chat/GroupCompositeAvatar";
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
        <GroupCompositeAvatar
          members={room.memberIds.map((id, i) => ({ id, name: room.memberNames[i] ?? id }))}
          size={28}
        />
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
