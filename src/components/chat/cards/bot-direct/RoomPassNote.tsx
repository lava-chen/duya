/**
 * RoomPassNote — Plan 489 P2.4 (group-chat silent-member placeholder).
 *
 * A lightweight reminder line shown when an agent was @-mentioned in a shared
 * room but chose not to speak. Keeps the timeline from looking like a dropped
 * message: it records that the agent saw the call-out and passed on a turn.
 *
 * Data not wired yet (group 478 ready first). TODO: mount this from the room
 * transcript once the server emits a "mentioned-but-silent" event for an
 * agent. Pure presentational: no state, no i18n (text is placeholder English —
 * route through useTranslation when keys land).
 */
import React from 'react';

export interface RoomPassNoteProps {
  /** The agent that was @-mentioned and passed on speaking. */
  agentName?: string;
  /** Optional reason for staying silent (e.g. "no answer", "defers"). */
  reason?: string;
}

export function RoomPassNote({ agentName, reason }: RoomPassNoteProps) {
  const who = agentName ? agentName : 'This member';
  return (
    <div
      data-testid="room-pass-note"
      className="my-1 flex items-center gap-2 px-3 py-1 text-[11px] italic text-[color:var(--muted)]"
    >
      <span aria-hidden className="shrink-0 select-none opacity-70">
        —
      </span>
      <span>
        {who} was mentioned but chose not to speak
        {reason ? ` (${reason})` : ''}
      </span>
    </div>
  );
}