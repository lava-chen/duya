"use client";

/**
 * GroupCompositeAvatar — shared composite avatar for room (group) chat.
 *
 * Used by the sidebar room row (28px) and the room chat header / empty state
 * (28px / 44px). Slot geometry mirrors rakazo's `groupSlots` (apps/web
 * agent-avatar.tsx):
 *   1 member  → full-frame avatar
 *   2 members → diagonal pair, 2/3 frame each
 *   3 members → triangle, 5/9 frame each
 *   4 members → 2×2 grid, 5/9 frame each
 *   5+        → triangle + a small overflow badge (`+{n-3}`)
 */

import React from "react";
import { BotCharacterAvatar } from "@/components/layout/sidebar/BotCharacterAvatar";

export interface GroupAvatarMember {
  id: string;
  name: string;
  avatarColor?: string;
  avatarUrl?: string;
}

interface GroupAvatarSlot {
  left: number;
  top: number;
  size: number;
}

/** Rakazo parity slot geometry for `count` members in a `frame`-px square. */
function groupAvatarSlots(count: number, frame: number): GroupAvatarSlot[] {
  if (count <= 1) return [{ left: 0, top: 0, size: frame }];
  if (count === 2) {
    const size = Math.round(frame * (2 / 3));
    const offset = frame - size;
    return [
      { left: 0, top: 0, size },
      { left: offset, top: offset, size },
    ];
  }
  const size = Math.round(frame * (5 / 9));
  const offset = frame - size;
  if (count === 3) {
    return [
      { left: Math.round(offset / 2), top: 0, size },
      { left: 0, top: offset, size },
      { left: offset, top: offset, size },
    ];
  }
  return [
    { left: 0, top: 0, size },
    { left: offset, top: 0, size },
    { left: 0, top: offset, size },
    { left: offset, top: offset, size },
  ];
}

export function GroupCompositeAvatar({
  members,
  size = 28,
}: {
  members: GroupAvatarMember[];
  size?: number;
}) {
  const count = members.length;
  if (count === 0) {
    return (
      <span
        className="inline-flex items-center justify-center rounded-full bg-[var(--bg-hover)] font-semibold text-[var(--text-muted)]"
        style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.42)) }}
        aria-hidden="true"
      >
        #
      </span>
    );
  }
  const showBadge = count > 4;
  const slots = groupAvatarSlots(showBadge ? 3 : Math.min(count, 4), size);
  const visible = members.slice(0, slots.length);
  return (
    <span className="relative inline-block" style={{ width: size, height: size }} aria-hidden="true">
      {visible.map((member, index) => {
        const slot = slots[index]!;
        return (
          <span
            key={member.id}
            className="absolute rounded-full"
            style={{ left: slot.left, top: slot.top, zIndex: index + 1 }}
          >
            <BotCharacterAvatar
              name={member.name}
              agentId={member.id}
              avatarColor={member.avatarColor}
              avatarUrl={member.avatarUrl}
              size={slot.size}
            />
          </span>
        );
      })}
      {showBadge && (
        <span
          className="absolute z-10 flex items-center justify-center rounded-full font-semibold"
          style={{
            right: 0,
            bottom: 0,
            minWidth: 14,
            height: 14,
            padding: "0 3px",
            fontSize: 9,
            lineHeight: 1,
            background: "var(--bg-hover)",
            border: "1px solid var(--text-muted)",
            color: "var(--text-muted)",
          }}
        >
          +{count - 3}
        </span>
      )}
    </span>
  );
}
