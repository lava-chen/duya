// Green/red diff-stat tail shared by the round summary row and the group
// header.
//
// The reference transcripts (Codex / Claude Code) always keep the stat
// visible at the END of the line — "… ran 13 commands +272 -77" — even
// when the verb phrase in front of it gets truncated. The badge is
// therefore `shrink-0` and rendered as its own element, never as part
// of the truncating text span.

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
      {additions > 0 && <span className="text-green-500">+{additions}</span>}
      {removals > 0 && (
        <span className={`text-red-500 ${additions > 0 ? 'ml-1' : ''}`}>-{removals}</span>
      )}
    </span>
  );
}
