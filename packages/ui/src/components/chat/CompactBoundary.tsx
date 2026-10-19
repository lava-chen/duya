import React from 'react';

interface CompactBoundaryProps {
  compactedMessageCount: number;
  timestamp?: number;
}

export function CompactBoundary({ compactedMessageCount, timestamp }: CompactBoundaryProps) {
  const timeStr = timestamp ? new Date(timestamp).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }) : '';

  return (
    <div className="compact-boundary">
      <div className="compact-boundary-line" />
      <span className="compact-boundary-text">
        {compactedMessageCount} messages compacted
        {timeStr && ` at ${timeStr}`}
      </span>
      <div className="compact-boundary-line" />
    </div>
  );
}