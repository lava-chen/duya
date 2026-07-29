import React, { useState } from 'react';
import { Button } from '@/components/ui/Button';

interface CompactSummaryProps {
  content: string;
  compactedMessageCount: number;
}

export function CompactSummary({ content, compactedMessageCount }: CompactSummaryProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="compact-summary">
      <Button
        variant="ghost"
        size="sm"
        className="compact-summary-toggle"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <span className="compact-summary-icon">{expanded ? '▾' : '▸'}</span>
        Context compacted ({compactedMessageCount} messages summarized)
      </Button>
      {expanded && (
        <div className="compact-summary-content">
          {content}
        </div>
      )}
    </div>
  );
}