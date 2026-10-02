/**
 * @vitest-environment jsdom
 *
 * Plugin @-mention links in markdown.
 *
 * The agent prompt itself emits this syntax (`[Name](plugin://id)` — see
 * packages/agent/src/mentions), so a model can echo it in its reply. Before
 * this, the markdown URL transform stripped the unknown `plugin:` scheme to an
 * empty string, leaving a link-styled but dead label in the assistant bubble.
 * Now the scheme survives on `href` only, and MarkdownAnchor renders the same
 * chip the composer and the user bubble use.
 */
import React from 'react';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer, preserveLocalUrlTransform } from './MarkdownRenderer';
import { markdownComponents } from './markdownComponents';

vi.mock('@/stores/conversation-store', () => ({
  useConversationStore: (selector: (state: unknown) => unknown) =>
    selector({ parentSessionId: null, activeThreadId: null, threads: [] }),
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

const Anchor = markdownComponents.a as React.FC<{ href?: string; children?: React.ReactNode }>;

describe('preserveLocalUrlTransform with plugin mentions', () => {
  it('keeps plugin:// on href', () => {
    expect(preserveLocalUrlTransform('plugin://wechat-pay', 'href')).toBe('plugin://wechat-pay');
  });

  it('still strips plugin:// on img src (widened allow-list stays href-only)', () => {
    expect(preserveLocalUrlTransform('plugin://wechat-pay', 'src')).toBe('');
  });

  it('still strips dangerous schemes on href', () => {
    expect(preserveLocalUrlTransform('javascript:alert(1)', 'href')).toBe('');
  });
});

describe('MarkdownAnchor plugin mention links', () => {
  it('renders the chip instead of an anchor and drops the leading @', () => {
    const { container } = render(<Anchor href="plugin://wechat-pay">@微信支付</Anchor>);

    expect(container.querySelector('a')).toBeNull();
    const chip = container.querySelector('[data-plugin-mention="wechat-pay"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe('微信支付');
  });

  it('falls back to @<pluginId> when the label is not plain text', () => {
    const { container } = render(
      <Anchor href="plugin://wechat-pay">
        <em>微信支付</em>
      </Anchor>,
    );
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('[data-plugin-mention="wechat-pay"]')?.textContent).toBe(
      '@wechat-pay',
    );
  });

  it('leaves ordinary links alone', () => {
    const { container } = render(<Anchor href="https://example.com/x">x</Anchor>);
    expect(container.querySelector('[data-plugin-mention]')).toBeNull();
    expect(container.querySelector('a')).not.toBeNull();
  });
});

describe('MarkdownRenderer end to end', () => {
  it('turns [@Name](plugin://id) in a reply into a chip', () => {
    const { container } = render(
      <MarkdownRenderer>{'我用 [@微信支付](plugin://wechat-pay) 处理了这笔账单。'}</MarkdownRenderer>,
    );

    expect(container.querySelector('a')).toBeNull();
    const chip = container.querySelector('[data-plugin-mention="wechat-pay"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe('微信支付');
    expect(container.textContent).toContain('我用');
  });
});
