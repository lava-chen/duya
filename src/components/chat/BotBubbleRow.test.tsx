// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { BotBubbleRow } from './BotBubbleRow';

// Rakazo parity for the message hover overlay: time label + pill pinned
// to the row's reserved top lane, streaming suppression, and the
// localStorage-backed thumbs-up toggle.
describe('BotBubbleRow', () => {
  beforeEach(() => {
    window.localStorage.removeItem('duya:bot-chat:thumbs-up');
  });

  it('renders the rakazo hover overlay with time label and pill', () => {
    const { container } = render(
      <BotBubbleRow
        role="user"
        text="hi"
        messageId="b1"
        timestamp={new Date(2026, 8, 5, 9, 30).getTime()}
      />,
    );
    const bar = container.querySelector('.bot-message-hover-metadata');
    expect(bar).not.toBeNull();
    expect(bar?.querySelector('time')).not.toBeNull();
    expect(bar?.querySelector('.bot-message-hover-pill')).not.toBeNull();
    expect(bar?.querySelector('[aria-label="Copy"]')).not.toBeNull();
    expect(bar?.querySelector('[aria-label="Add thumbs-up"]')).not.toBeNull();
  });

  it('suppresses the hover overlay while streaming (rakazo progress exemption)', () => {
    const { container } = render(<BotBubbleRow role="assistant" isStreaming />);
    expect(container.querySelector('.bot-message-hover-metadata')).toBeNull();
    expect(container.querySelector('.bot-chat-typing')).not.toBeNull();
  });

  it('omits the thumbs-up toggle when no messageId is given', () => {
    const { container } = render(<BotBubbleRow role="user" text="hi" />);
    expect(container.querySelector('[aria-label="Add thumbs-up"]')).toBeNull();
    expect(container.querySelector('[aria-label="Copy"]')).not.toBeNull();
  });

  it('persists a thumbs-up to localStorage and shows the badge below the bubble', () => {
    const { container } = render(
      <BotBubbleRow role="assistant" text="可反应" messageId="b2" />,
    );
    const btn = container.querySelector('[aria-label="Add thumbs-up"]');
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    expect(btn?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.bot-chat-thumbs-badge')).not.toBeNull();
    const stored = JSON.parse(
      window.localStorage.getItem('duya:bot-chat:thumbs-up') || '[]',
    ) as string[];
    expect(stored).toContain('b2');

    // Badge click removes the reaction again.
    fireEvent.click(container.querySelector('.bot-chat-thumbs-badge')!);
    expect(container.querySelector('.bot-chat-thumbs-badge')).toBeNull();
    const storedAfter = JSON.parse(
      window.localStorage.getItem('duya:bot-chat:thumbs-up') || '[]',
    ) as string[];
    expect(storedAfter).not.toContain('b2');
  });
});
