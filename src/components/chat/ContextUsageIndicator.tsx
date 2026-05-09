'use client';

import type { ContextUsage } from '@/types/message';

interface ContextUsageIndicatorProps {
  contextUsage: ContextUsage | null;
}

function formatTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function getColorClass(percentFull: number): string {
  if (percentFull < 60) return 'bg-green-500';
  if (percentFull < 80) return 'bg-yellow-500';
  return 'bg-red-500';
}

function getTextClass(percentFull: number): string {
  if (percentFull < 60) return 'text-green-500';
  if (percentFull < 80) return 'text-yellow-500';
  return 'text-red-500';
}

export function ContextUsageIndicator({ contextUsage }: ContextUsageIndicatorProps) {
  if (!contextUsage) {
    return null;
  }

  const { usedTokens, contextWindow, percentFull } = contextUsage;
  const percentage = Math.round(percentFull);

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={getTextClass(percentFull)}>
        Context: {percentage}%
      </span>
      <div className="w-16 h-1.5 bg-neutral-700 rounded-full overflow-hidden">
        <div
          className={`h-full ${getColorClass(percentFull)} transition-all duration-300`}
          style={{ width: `${Math.min(percentage, 100)}%` }}
        />
      </div>
      <span className="text-neutral-500">
        {formatTokens(usedTokens)}/{formatTokens(contextWindow)}
      </span>
    </div>
  );
}
