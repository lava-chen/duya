/**
 * @vitest-environment jsdom
 *
 * Regression tests for the code-block memo.
 *
 * A streaming reply re-parses its markdown on every animation frame, so every
 * fence inside the growing block is re-rendered on every frame — and
 * re-rendering a fence means re-tokenizing and re-highlighting it, which the
 * streaming benchmark measured as ~78% of the main-thread time of a long
 * streamed reply (1299ms -> 298ms when the same code is not tokenized).
 *
 * The memo makes a COMPLETED fence compare equal across those frames, so it
 * is not re-highlighted. These tests pin the three properties that make that
 * safe: an unchanged fence is not re-highlighted, a changed one is, and a
 * theme switch still reaches it.
 */
import { act, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MarkdownRenderer } from '../MarkdownRenderer';

const highlightCalls: string[] = [];

vi.mock('@/lib/prism-languages', () => ({
  SyntaxHighlighter: (props: { children?: React.ReactNode }) => {
    highlightCalls.push(String(props.children ?? ''));
    return <pre data-testid="highlighted">{props.children}</pre>;
  },
}));

vi.mock('@/stores/conversation-store', () => ({
  useConversationStore: (selector: unknown) =>
    (selector as (s: unknown) => unknown)({
      parentSessionId: null,
      activeThreadId: null,
      threads: [],
    }),
}));

vi.mock('@/hooks/useLinkOpener', () => ({
  useLinkOpener: () => ({
    openLinksInExternalBrowser: false,
    openLink: vi.fn(),
    setOpenLinksInExternalBrowser: vi.fn(),
  }),
}));

vi.mock('@/lib/link-favicon', () => ({
  useLinkFavicon: () => null,
}));

const FENCE = '```ts\nconst answer = 42;\n```';

beforeEach(() => {
  highlightCalls.length = 0;
  document.documentElement.setAttribute('data-theme', 'dark');
});

describe('CodeBlock memo', () => {
  it('does not re-highlight a completed fence when the reply around it grows', () => {
    const { rerender } = render(<MarkdownRenderer>{`${FENCE}\n\nfirst paragraph`}</MarkdownRenderer>);
    expect(highlightCalls).toHaveLength(1);

    // The reply keeps streaming: the fence is untouched, the paragraph after
    // it grew. The fence must not be tokenized again.
    rerender(<MarkdownRenderer>{`${FENCE}\n\nfirst paragraph, and more of it`}</MarkdownRenderer>);
    expect(highlightCalls).toHaveLength(1);
  });

  it('re-highlights a fence whose own content changed', () => {
    const { rerender } = render(<MarkdownRenderer>{FENCE}</MarkdownRenderer>);
    expect(highlightCalls).toHaveLength(1);

    // A fence that is still open grows with the stream: its content really
    // did change, so the highlight has to be redone.
    rerender(<MarkdownRenderer>{'```ts\nconst answer = 43;\n```'}</MarkdownRenderer>);
    expect(highlightCalls).toHaveLength(2);
  });

  it('still re-renders when the theme changes', async () => {
    render(<MarkdownRenderer>{FENCE}</MarkdownRenderer>);
    expect(highlightCalls).toHaveLength(1);

    // The theme is read from the document, not from props, so a memo that
    // only compared props would freeze the code block in the old palette.
    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'light');
      await Promise.resolve();
    });

    expect(highlightCalls.length).toBeGreaterThan(1);
  });
});
