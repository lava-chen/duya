/**
 * RoomRoundMark — Plan 489 P2.4 (group / shared-room turn separator).
 *
 * Marks the boundary between agent conversation rounds in a shared room
 * (group-chat 478). Renders a horizontal divider with a small badge on the
 * left naming the agent whose turn just spoke ("<agent> most recently", or a
 * generic "round" marker when no agent is known).
 *
 * Data not wired yet (group 478 ready first). TODO: mount this from the room
 * transcript stream once turn-start metadata is emitted server-side. Pure
 * presentational: no state, no i18n (text is placeholder English — route
 * through useTranslation when keys land).
 */
import React from 'react';

export interface RoomRoundMarkProps {
  /** Agent whose turn the marker introduces/summarizes. */
  agentName?: string;
  /** Names of other agents that took part in the prior round. */
  previousParticipants?: string[];
  /** Custom badge text; falls back to "round" when populated. */
  label?: string;
}

export function RoomRoundMark({
  agentName,
  previousParticipants,
  label,
}: RoomRoundMarkProps) {
  const badgeText = label ?? agentName ?? 'round';
  const participants =
    previousParticipants && previousParticipants.length > 0
      ? previousParticipants
      : null;

  return (
    <div
      data-testid="room-round-mark"
      className="my-2 flex items-center gap-2 px-2"
      role="separator"
    >
      <span
        data-badge-agent={agentName ? 'true' : undefined}
        className="shrink-0 rounded-full border border-[color:var(--border)] bg-[color:var(--surface-solid)] px-2.5 py-0.5 text-[11px] font-medium text-[color:var(--muted)]"
      >
        {badgeText}
      </span>
      <span className="h-px flex-1 bg-[color:var(--border-weak)]" />
      {participants && (
        <span className="shrink-0 text-[11px] text-[color:var(--muted)]">
          {participants.join(', ')}
        </span>
      )}
    </div>
  );
}