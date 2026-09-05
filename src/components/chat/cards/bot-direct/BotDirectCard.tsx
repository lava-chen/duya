/**
 * BotDirectCard — Plan 489 P2.4 (agent 1:1 DM message envelope).
 *
 * A message "envelope" that agent-side delivery / coordination / broadcast
 * cards slide into. It visually distinguishes bot-injected delivery (readable
 * note when the agent hands you something, event when it fires a lifecycle
 * event) from the user's own plain bubbles.
 *
 *   - kind 'readable note' → relaxed, accent-tinted note surface
 *   - kind 'event'         → neutral, bordered surface
 *   - title is an optional small uppercase kicker; children hold the body.
 *
 * Data not wired yet (plan 498 / group-chat 478 land first). TODO: mount this
 * from BotDirectChatView's render loop once the send/event payload carries a
 * kind + envelope payload. Pure presentational: no state, no i18n (all strings
 * above are placeholder English — move to useTranslation when keys land).
 */
import React from 'react';

export interface BotDirectCardProps {
  /** What kind of envelope this is. */
  kind: 'readable note' | 'event';
  /** Optional small uppercase kicker above the body. */
  title?: string;
  /** Card body. */
  children?: React.ReactNode;
}

export function BotDirectCard({ kind, title, children }: BotDirectCardProps) {
  const isNote = kind === 'readable note';
  return (
    <div
      data-testid="bot-direct-card"
      data-kind={kind}
      className={
        'flex flex-col gap-1.5 rounded-2xl border p-3 ' +
        (isNote
          ? 'border-[color:var(--accent-soft)] bg-[color:var(--accent-soft)]'
          : 'border-[color:var(--border)] bg-[color:var(--surface-solid)]')
      }
    >
      {title && (
        <div className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--muted)]">
          {title}
        </div>
      )}
      {children}
    </div>
  );
}