/**
 * @vitest-environment jsdom
 */

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@/types';
import { MessageItem } from './MessageItem';

vi.mock('./MarkdownRenderer', () => ({
  MarkdownRenderer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="markdown">{children}</div>
  ),
}));

vi.mock('./ToolActionsGroup', () => ({
  ToolActionsGroup: ({ actions }: { actions: Array<{ kind: string; content?: string; tool?: { name: string } }> }) => (
    <div data-testid="tool-actions">
      {actions.map((action, index) => (
        <div key={index} data-kind={action.kind}>
          {action.kind === 'text' ? action.content : action.kind === 'tool' ? action.tool?.name : action.kind}
        </div>
      ))}
    </div>
  ),
  pairTools: vi.fn(() => []),
}));

vi.mock('./WidgetRenderer', () => ({
  WidgetRenderer: () => <div data-testid="widget" />,
}));

vi.mock('./WidgetErrorBoundary', () => ({
  WidgetErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/stores/conversation-store', () => ({
  // The shape of the conversation store has grown beyond what this
  // legacy mock returns. `MessageItem` now reads `activeThreadId` and
  // `threads` to compute the working directory; without them, the
  // component throws `Cannot read properties of undefined (reading
  // 'find')` at `threads.find(...)`. Add fields here as new selectors
  // get introduced.
  useConversationStore: (selector: (state: {
    parentSessionId: string | null;
    activeThreadId: string | null;
    threads: Array<{ id: string; workingDirectory?: string }>;
  }) => unknown) =>
    selector({
      parentSessionId: null,
      activeThreadId: null,
      threads: [],
    }),
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    locale: 'en',
    t: (_key: string, params?: Record<string, string | number>) =>
      params?.time ? String(params.time) : '',
  }),
}));

function assistantMessage(overrides: Partial<Message>): Message {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    timestamp: 1000,
    msgType: 'text',
    ...overrides,
  };
}

describe('MessageItem action grouping', () => {
  it('renders text-only assistant replies outside the actions group', () => {
    render(
      <MessageItem
        message={assistantMessage({
          content: 'Plain final answer',
        })}
      />,
    );

    expect(screen.queryByTestId('tool-actions')).not.toBeInTheDocument();
    expect(screen.getByTestId('markdown')).toHaveTextContent('Plain final answer');
  });

  it('keeps intermediate text in the action group in order and lifts only the trailing run into finalText', () => {
    render(
      <MessageItem
        message={assistantMessage({
          id: 'intro',
          content: 'I will inspect this first.',
          timestamp: 1000,
        })}
        mergedMessages={[
          assistantMessage({
            id: 'tool',
            content: '',
            timestamp: 1001,
            msgType: 'tool_use',
            toolName: 'Read',
            tool_call_id: 'tool-1',
            toolInput: '{"file_path":"src/example.ts"}',
          }),
          assistantMessage({
            id: 'final',
            content: 'Here is the final answer.',
            timestamp: 1002,
          }),
        ]}
      />,
    );

    // The intermediate text fragment stays inline in the action group
    // (chronological order, before the Read row)...
    expect(screen.getByTestId('tool-actions')).toHaveTextContent('Read');
    expect(screen.getByTestId('tool-actions')).toHaveTextContent('I will inspect this first.');
    // ...while only the trailing run after the last tool call renders as
    // the agent's actual final reply.
    const markdownNodes = screen.getAllByTestId('markdown');
    expect(markdownNodes).toHaveLength(1);
    expect(markdownNodes[0].textContent).toBe('Here is the final answer.');
    expect(markdownNodes[0].textContent).not.toContain('I will inspect this first.');
  });

  it('joins multiple text blocks with a newline so block-level markdown is not glued', () => {
    render(
      <MessageItem
        message={assistantMessage({
          id: 'multi-block',
          content: [
            { type: 'text', text: '第一段正文' },
            { type: 'text', text: '### 第二段标题' },
          ],
        })}
      />,
    );

    // toHaveTextContent normalizes whitespace, so assert on raw textContent
    // to prove the newline separator survives multi-block assembly.
    expect(screen.getByTestId('markdown').textContent).toBe('第一段正文\n\n### 第二段标题');
  });

  it('smart-joins trailing text fragments so a split table keeps parsing in one markdown document', () => {
    // A tool call, then the final reply arriving as two text blocks:
    // the table header/separator in the first, the data rows in the
    // second. They must join with a single newline — a blank line would
    // end the GFM table and render the data rows as literal pipes.
    render(
      <MessageItem
        message={assistantMessage({
          id: 'mixed-turn',
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'web_search',
              input: { query: 'markdown tables' },
            },
            { type: 'text', text: '结果如下：\n| A | B |\n| --- | --- |' },
            { type: 'text', text: '| 1 | 2 |\n| 3 | 4 |' },
          ],
          timestamp: 1000,
        })}
        mergedMessages={[]}
      />,
    );

    const markdownNodes = screen.getAllByTestId('markdown');
    expect(markdownNodes).toHaveLength(1);
    expect(markdownNodes[0].textContent).toBe(
      '结果如下：\n| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |',
    );
  });

  it('keeps widgets interleaved while still merging surrounding text', () => {
    render(
      <MessageItem
        message={assistantMessage({
          id: 'with-widget',
          content: [
            { type: 'text', text: 'before widget' },
            {
              type: 'tool_use',
              id: 'widget-1',
              name: 'show_widget',
              input: { widget_code: 'console.log(1)' },
            },
            { type: 'text', text: 'after widget' },
          ],
          timestamp: 1000,
        })}
        mergedMessages={[]}
      />,
    );

    // text still aggregated into a single MarkdownRenderer via finalText
    const markdownNodes = screen.getAllByTestId('markdown');
    expect(markdownNodes).toHaveLength(1);
    expect(markdownNodes[0].textContent).toBe('before widget\n\nafter widget');

    // widget still rendered as an independent block in the same bubble
    expect(screen.getByTestId('widget')).toBeInTheDocument();
  });
});
