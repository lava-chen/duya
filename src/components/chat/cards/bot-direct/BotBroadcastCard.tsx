/**
 * BotBroadcastCard — Plan 489 P2.4 (multi-agent broadcast summary).
 *
 * Summarizes one message an agent broadcast to other bot members of a group /
 * shared room. Expanded: an agent avatar-initial header + body text per member.
 * Collapsed: a single compact "n agent(s)" chip so long fan-outs collapse to
 * one line.
 *
 * Data not wired yet (group 478 ready first). TODO: mount this from the room
 * transcript once broadcast metadata (target member list + content) is emitted
 * server-side. Pure presentational: no state, no i18n (text is placeholder
 * English — route through useTranslation when keys land).
 */
import React from 'react';

export interface BotBroadcastCardAgent {
  /** Member name (shown as the card header). */
  name: string;
  /** Optional single-letter avatar initial. */
  avatarInitial?: string;
  /** Broadcast body shown to this member. */
  text: string;
}

export interface BotBroadcastCardProps {
  /** Members the broadcast reached. */
  agents: BotBroadcastCardAgent[];
  /** Collapse to a single "n agent(s)" line. */
  collapsed?: boolean;
}

export function BotBroadcastCard({ agents, collapsed = false }: BotBroadcastCardProps) {
  if (collapsed) {
    return (
      <div
        data-testid="bot-broadcast-card"
        data-collapsed="true"
        className="inline-flex items-center gap-2 rounded-full border border-[color:var(--border)] bg-[color:var(--surface-solid)] px-3 py-1 text-[11px] text-[color:var(--muted)]"
      >
        <span aria-hidden className="shrink-0 select-none opacity-70">
          📣
        </span>
        <span>
          {agents.length} {agents.length === 1 ? 'agent' : 'agents'}
        </span>
      </div>
    );
  }

  return (
    <div
      data-testid="bot-broadcast-card"
      data-collapsed="false"
      className="flex flex-col gap-2"
    >
      {agents.map((agent, i) => (
        <div
          key={i}
          className="flex items-start gap-2 rounded-xl border border-[color:var(--border)] bg-[color:var(--surface-solid)] p-2.5"
        >
          <span
            aria-hidden
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[color:var(--accent-soft)] text-[11px] font-semibold text-[color:var(--accent)]"
          >
            {agent.avatarInitial ?? agent.name.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-medium text-[color:var(--text)]">
              {agent.name}
            </div>
            <div className="text-[12px] leading-relaxed text-[color:var(--muted)]">
              {agent.text}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}