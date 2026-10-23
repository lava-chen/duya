// Green/red diff-stat tail on a group header.
//
// The reference transcripts (Codex / Claude Code) always keep the stat
// visible at the END of the line — "… ran 13 commands +272 -77" — even
// when the verb phrase in front of it gets truncated. The badge is
// therefore `shrink-0` and rendered as its own element, never as part
// of the truncating text span.
//
// Both numbers are always shown ("+28 -0"), the same way the per-row
// stats read — a zero removal count still tells the reader the file
// was touched without losing a line.

'use client';

import React from 'react';

interface DiffStatBadgeProps {
  additions: number;
  removals: number;
}

export function DiffStatBadge({ additions, removals }: DiffStatBadgeProps) {
  if (additions <= 0 && removals <= 0) return null;
  return (
    <span
      className="font-mono text-[11px] tabular-nums shrink-0 whitespace-nowrap"
      data-testid="diff-stat"
    >
      <span className="text-[var(--diff-added-text)]">+{additions}</span>
      <span className="ml-1 text-[var(--diff-removed-text)]">-{removals}</span>
    </span>
  );
}
