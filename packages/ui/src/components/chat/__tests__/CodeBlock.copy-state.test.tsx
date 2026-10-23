/**
 * @vitest-environment jsdom
 *
 * Regression tests for the copy button of the memoized code block.
 *
 * `CodeBlock` is wrapped in `React.memo` with a comparator that only looks at
 * the fence text, the language class and the button labels. The "copied"
 * state lives INSIDE the component, so the memo must never freeze it: the
 * button has to switch to "Copied" after a click, keep that state while the
 * surrounding reply keeps streaming (the parent re-renders with unchanged
 * props, which is exactly the case the memo short-circuits), and fall back to
 * "Copy" once the confirmation expires.
 *
 * `CodeBlock.memo.test.tsx` covers the highlighting side of the same change;
 * this file covers the button.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { MarkdownRenderer } from '../MarkdownRenderer';

vi.mock('@/lib/prism-languages', () => ({
  SyntaxHighlighter: (props: { children?: React.ReactNode }) => (
    <pre data-testid="highlighted">{props.children}</pre>
  ),
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
const COPY_TIMEOUT_MS = 2000;

const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  writeText.mockClear();
  // Only the timeout is faked: `setImmediate` stays real so React's async
  // `act` can flush its work loop.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  document.documentElement.setAttribute('data-theme', 'dark');
});

afterEach(() => {
  vi.useRealTimers();
});

/** Click the copy button and let the clipboard promise settle. */
async function clickCopy() {
  const button = screen.getByRole('button', { name: 'Copy' });
  await act(async () => {
    fireEvent.click(button);
    await Promise.resolve();
  });
  return button;
}

describe('CodeBlock copy state', () => {
  it('switches the button to the copied label after a click', async () => {
    render(<MarkdownRenderer>{FENCE}</MarkdownRenderer>);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();

    await clickCopy();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('const answer = 42;');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('keeps the copied state when the reply around the fence grows', async () => {
    const { rerender } = render(<MarkdownRenderer>{`${FENCE}\n\nfirst paragraph`}</MarkdownRenderer>);
    await clickCopy();
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();

    // The reply keeps streaming: the fence is untouched, so the memo skips
    // the re-render. The copied state must survive it.
    rerender(<MarkdownRenderer>{`${FENCE}\n\nfirst paragraph, and more of it`}</MarkdownRenderer>);

    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('falls back to the copy label when the confirmation expires', async () => {
    render(<MarkdownRenderer>{FENCE}</MarkdownRenderer>);
    await clickCopy();
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(COPY_TIMEOUT_MS + 50);
    });

    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });
});
