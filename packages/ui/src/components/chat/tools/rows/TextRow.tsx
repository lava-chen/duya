// TextRow — renders the agent's text content. The last (still-growing)
// text block is paced with the adaptive typewriter so the user sees
// text stream in smoothly instead of jumping in SSE chunk sizes. Older
// (stable) blocks render their full content immediately.
//
// If the content contains a ```show-widget``` fence, the body is split
// into text / widget segments and each widget is rendered through
// WidgetRenderer (with a WidgetErrorBoundary so a bad widget doesn't
// take down the whole message).

'use client';

import React from 'react';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import { WidgetRenderer } from '../../WidgetRenderer';
import { WidgetErrorBoundary } from '../../WidgetErrorBoundary';
import { parseAllShowWidgets } from '@/lib/widget-parser';
import { useAdaptiveTypewriter } from '@/hooks/useAdaptiveTypewriter';

interface TextRowProps {
  content: string;
  isStreaming?: boolean;
}

export function TextRow({ content, isStreaming }: TextRowProps) {
  // When this is the live, growing text block, pace it with the adaptive
  // typewriter so the user sees the text stream in smoothly instead of
  // jumping in SSE chunk sizes. Older (stable) blocks render their full
  // content immediately — the typewriter's rAF loop is a no-op for them
  // because their target length is already caught up to displayed.
  const displayedContent = useAdaptiveTypewriter(content, !!isStreaming);
  const renderSource = isStreaming ? displayedContent : content;

  const hasWidgetFence = content.includes('```show-widget');

  if (!hasWidgetFence) {
    return (
      <MarkdownRenderer className="px-2 py-1.5 text-sm text-foreground/90 prose prose-sm dark:prose-invert max-w-none message-content">
        {renderSource}
      </MarkdownRenderer>
    );
  }

  const segments = parseAllShowWidgets(renderSource);
  const hasWidgets = segments.some(s => s.type === 'widget');

  if (!hasWidgets) {
    return (
      <MarkdownRenderer className="px-2 py-1.5 text-sm text-foreground/90 prose prose-sm dark:prose-invert max-w-none message-content">
        {renderSource}
      </MarkdownRenderer>
    );
  }

  return (
    <div className="px-2 py-1.5">
      {segments.map((seg, i) => {
        if (seg.type === 'text') {
          return (
            <MarkdownRenderer
              key={`t-${i}`}
              className="text-sm text-foreground/90 prose prose-sm dark:prose-invert max-w-none message-content"
            >
              {seg.content || ''}
            </MarkdownRenderer>
          );
        }
        if (seg.type === 'widget' && seg.data) {
          return (
            <WidgetErrorBoundary key={`w-${i}`} widgetCode={seg.data.widget_code}>
              <WidgetRenderer
                widgetCode={seg.data.widget_code}
                isStreaming={false}
                sourceLabel="Tool result"
              />
            </WidgetErrorBoundary>
          );
        }
        return null;
      })}
    </div>
  );
}
