/**
 * @vitest-environment jsdom
 *
 * Regression tests for local-path markdown images.
 *
 * Root cause (2026-08-26): react-markdown's `defaultUrlTransform` strips any
 * URL whose scheme is not in its safe allow-list. A Windows drive path such
 * as `E:/Projects/a.png` is parsed with scheme `e:` and silently emptied, so
 * `![x](E:\a.png)` rendered as `<img alt="x">` with NO src — the custom
 * MarkdownImage component never received a usable path and the duya-file://
 * rewrite in rewriteMediaSrc was dead code on this path.
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer, preserveLocalUrlTransform } from './MarkdownRenderer';

vi.mock('./ImagePreviewModal', () => ({
  ImagePreviewModal: () => <div data-testid="image-preview-modal" />,
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

function firstImgSrc(markdown: string): string | null {
  const { container } = render(<MarkdownRenderer>{markdown}</MarkdownRenderer>);
  const img = container.querySelector('img');
  return img?.getAttribute('src') ?? null;
}

describe('preserveLocalUrlTransform', () => {
  it('keeps duya-file URLs', () => {
    expect(preserveLocalUrlTransform('duya-file:///E:/a.png')).toBe(
      'duya-file:///E:/a.png',
    );
  });

  it('normalizes backslashes in Windows drive paths', () => {
    expect(preserveLocalUrlTransform('C:\\Users\\me\\a.png')).toBe(
      'C:/Users/me/a.png',
    );
  });

  it('still strips javascript: URLs via the default transform', () => {
    expect(preserveLocalUrlTransform('javascript:alert(1)')).toBe('');
    expect(preserveLocalUrlTransform('https://example.com/a.png')).toBe(
      'https://example.com/a.png',
    );
  });
});

describe('MarkdownRenderer embeds local-path images end to end', () => {
  it('renders a Windows backslash path (as agents actually emit it)', () => {
    // Single backslashes in the source text — the JSONL escaping (`\\`) is
    // not part of the message content.
    expect(firstImgSrc('![屏 1](E:\\Projects\\MCTS\\video\\a.png)')).toBe(
      'duya-file:///E:/Projects/MCTS/video/a.png',
    );
  });

  it('renders a Windows forward-slash path (prompt-taught form)', () => {
    expect(firstImgSrc('![x](C:/Users/me/plot.png)')).toBe(
      'duya-file:///C:/Users/me/plot.png',
    );
  });

  it('renders an already-rewritten duya-file URL', () => {
    expect(firstImgSrc('![x](duya-file:///home/me/a.png)')).toBe(
      'duya-file:///home/me/a.png',
    );
  });

  it('renders a Unix absolute path', () => {
    expect(firstImgSrc('![x](/tmp/shots/frame_4s.png)')).toBe(
      'duya-file:///tmp/shots/frame_4s.png',
    );
  });

  it('renders the shortened /abs/<drive> placeholder form', () => {
    // Models sometimes merge the taught `/abs/path` placeholder with a
    // Windows drive path: `/abs/E:/Projects/a.png`.
    expect(firstImgSrc('![x](/abs/E:/Projects/MCTS/frame_4s.png)')).toBe(
      'duya-file:///E:/Projects/MCTS/frame_4s.png',
    );
  });
});
