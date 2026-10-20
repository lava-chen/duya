/**
 * CodeViewer - Unified code display with line numbers
 * Similar to SimpleDiffViewer but for displaying file content
 */

'use client';

import React from 'react';

interface CodeViewerProps {
  content: string;
  startLine?: number;
  maxHeight?: number;
  fileName?: string;
}

export function CodeViewer({
  content,
  startLine = 1,
  maxHeight = 400,
}: CodeViewerProps) {
  const lines = content.split('\n');

  return (
    <div
      className="overflow-auto rounded border border-border/50"
      style={{ maxHeight }}
    >
      <div className="font-mono text-[13px] leading-5 bg-card">
        {lines.map((line, idx) => {
          const lineNum = startLine + idx;

          return (
            <div
              key={idx}
              className="flex hover:bg-muted/30 transition-colors"
            >
              {/* Line number */}
              <div className="shrink-0 w-12 text-right pr-3 text-muted-foreground/40 select-none text-[12px] bg-muted/20">
                {lineNum}
              </div>
              {/* Content */}
              <div className="flex-1 overflow-hidden pr-4 text-foreground">
                <pre className="m-0 p-0 bg-transparent whitespace-pre-wrap break-all">
                  <code>{line || ' '}</code>
                </pre>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default CodeViewer;
