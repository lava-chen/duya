/**
 * SimpleDiffViewer - GitHub/VS Code style split diff display
 * Shows deletions first (red), then additions (green)
 */

'use client';

import React, { useMemo } from 'react';

interface SimpleDiffViewerProps {
  oldContent?: string;
  newContent: string;
  maxHeight?: number;
}

export interface DiffStats {
  additions: number;
  removals: number;
}

interface DiffLine {
  type: 'add' | 'remove';
  content: string;
  lineNum: number;
}

/**
 * Calculate diff - returns deletions first, then additions (split diff style)
 */
export function calculateDiff(oldContent: string, newContent: string): { lines: DiffLine[]; stats: DiffStats } {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const removals: DiffLine[] = [];
  const additions: DiffLine[] = [];

  let oldIdx = 0;
  let newIdx = 0;

  while (oldIdx < oldLines.length || newIdx < newLines.length) {
    const oldLine = oldLines[oldIdx];
    const newLine = newLines[newIdx];

    if (oldIdx >= oldLines.length) {
      // Only new lines remain - additions
      additions.push({
        type: 'add',
        content: newLine,
        lineNum: newIdx + 1,
      });
      newIdx++;
    } else if (newIdx >= newLines.length) {
      // Only old lines remain - removals
      removals.push({
        type: 'remove',
        content: oldLine,
        lineNum: oldIdx + 1,
      });
      oldIdx++;
    } else if (oldLine === newLine) {
      // Lines match - skip (don't show context lines)
      oldIdx++;
      newIdx++;
    } else {
      // Lines differ - check if it's a replacement or separate changes
      const nextOldMatch = newLines.slice(newIdx + 1).indexOf(oldLine);
      const nextNewMatch = oldLines.slice(oldIdx + 1).indexOf(newLine);

      if (nextOldMatch !== -1 && (nextNewMatch === -1 || nextOldMatch < nextNewMatch)) {
        // Additions (old line appears later in new)
        for (let i = 0; i <= nextOldMatch; i++) {
          additions.push({
            type: 'add',
            content: newLines[newIdx + i],
            lineNum: newIdx + i + 1,
          });
        }
        newIdx += nextOldMatch + 1;
      } else if (nextNewMatch !== -1) {
        // Removals (new line appears later in old)
        for (let i = 0; i <= nextNewMatch; i++) {
          removals.push({
            type: 'remove',
            content: oldLines[oldIdx + i],
            lineNum: oldIdx + i + 1,
          });
        }
        oldIdx += nextNewMatch + 1;
      } else {
        // Replacement - show both
        removals.push({
          type: 'remove',
          content: oldLine,
          lineNum: oldIdx + 1,
        });
        additions.push({
          type: 'add',
          content: newLine,
          lineNum: newIdx + 1,
        });
        oldIdx++;
        newIdx++;
      }
    }
  }

  // Return removals first, then additions (split diff style)
  return {
    lines: [...removals, ...additions],
    stats: { additions: additions.length, removals: removals.length }
  };
}

export function SimpleDiffViewer({
  oldContent = '',
  newContent,
  maxHeight = 400,
}: SimpleDiffViewerProps) {
  const { lines, stats } = useMemo(() => {
    return calculateDiff(oldContent, newContent);
  }, [oldContent, newContent]);

  if (lines.length === 0) {
    return (
      <div className="rounded border border-border/50 overflow-hidden bg-card p-4 text-sm text-muted-foreground text-center">
        No changes
      </div>
    );
  }

  return (
    <div
      className="overflow-auto rounded border border-border/50"
      style={{ maxHeight }}
    >
      <div className="font-mono text-[13px] leading-5 bg-card">
        {lines.map((line, idx) => {
          // Determine if this is the first addition (to add a separator)
          const isFirstAdd = line.type === 'add' &&
            idx > 0 &&
            lines[idx - 1].type === 'remove';

          // VS Code/GitHub style colors
          const bgClass = line.type === 'add'
            ? 'bg-[#2ea04326]'
            : 'bg-[#f8514926]';

          const textClass = 'text-foreground';

          // Left border indicator
          const borderClass = line.type === 'add'
            ? 'border-l-[3px] border-l-green-500'
            : 'border-l-[3px] border-l-red-500';

          return (
            <React.Fragment key={idx}>
              {/* Separator between removals and additions */}
              {isFirstAdd && (
                <div className="h-0 border-t border-border/30" />
              )}
              <div
                className={`flex ${bgClass} ${borderClass} hover:bg-opacity-80 transition-colors`}
              >
                {/* Line number */}
                <div className={`shrink-0 w-12 text-right pr-3 text-muted-foreground/40 select-none text-[12px]`}>
                  {line.lineNum}
                </div>
                {/* Content */}
                <div className={`flex-1 overflow-hidden pr-4 ${textClass}`}>
                  <pre className="m-0 p-0 bg-transparent whitespace-pre-wrap break-all">
                    <code>{line.content || ' '}</code>
                  </pre>
                </div>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

export default SimpleDiffViewer;
