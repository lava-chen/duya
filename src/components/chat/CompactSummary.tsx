import React, { useState } from 'react';

interface CompactSummaryProps {
  content: string;
  compactedMessageCount: number;
}

export function CompactSummary({ content, compactedMessageCount }: CompactSummaryProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="compact-summary">
      <button
        className="compact-summary-toggle"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <span className="compact-summary-icon">{expanded ? '▾' : '▸'}</span>
        Context compacted ({compactedMessageCount} messages summarized)
      </button>
      {expanded && (
        <div className="compact-summary-content">
          {content}
        </div>
      )}
    </div>
  );
}