/**
 * @vitest-environment jsdom
 *
 * CompactSummary row tests. Verifies that:
 *   - the collapsed row renders the compaction verb + compacted count
 *   - clicking the row expands the compressed summary card
 *   - the summary text is NOT visible while collapsed
 *   - an empty summary leaves the row inert (nothing to reveal)
 *
 * The ActionRowChrome dependency is stubbed so assertions stay focused
 * on CompactSummary's own behavior, not the shared chrome.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
    locale: 'en',
  }),
}));

vi.mock('./tools/chrome/ActionRowChrome', () => ({
  ActionRowChrome: ({
    children,
    status,
    onClick,
    canExpand,
    icon,
    rightSlot,
    // The real chrome resolves verbKey through t() and renders the verb
    // before the children; mirror that contract so collapsed-label
    // assertions exercise what users actually see.
    verbKey,
  }: {
    children: React.ReactNode;
    status: string;
    onClick?: () => void;
    canExpand: boolean;
    icon?: React.ReactNode;
    rightSlot?: React.ReactNode;
    verbKey?: string;
  }) => (
    <div data-testid="chrome" data-status={status} data-can-expand={canExpand ? '1' : '0'}>
      {icon}
      {verbKey ? (
        <span data-testid="chrome-verb">{verbKey}</span>
      ) : null}
      <button data-testid="chrome-button" onClick={onClick}>
        {children}
      </button>
      {rightSlot}
    </div>
  ),
}));

import { CompactSummary } from './CompactSummary';

describe('CompactSummary', () => {
  it('renders collapsed with the compaction verb and count slot', () => {
    render(<CompactSummary content="summary body" compactedMessageCount={7} />);
    const chrome = screen.getByTestId('chrome');
    expect(chrome).toHaveAttribute('data-status', 'success');
    expect(chrome).toHaveAttribute('data-can-expand', '1');
    // Collapsed label uses the i18n key (mocked to the key itself).
    expect(screen.getByText('streaming.toolAction.compact.collapsed')).toBeInTheDocument();
    // Count tail interpolates the pluralized key with the count param.
    expect(
      screen.getByText(/streaming\.toolAction\.compact\.messagesCompacted\.other/),
    ).toBeInTheDocument();
    // Summary text is NOT visible until expanded.
    expect(screen.queryByText('summary body')).not.toBeInTheDocument();
  });

  it('expands to show the compressed summary on click', () => {
    render(<CompactSummary content="the earlier conversation covered X" compactedMessageCount={3} />);
    fireEvent.click(screen.getByTestId('chrome-button'));
    expect(screen.getByText('the earlier conversation covered X')).toBeInTheDocument();
  });

  it('uses the singular count key when one message was compacted', () => {
    render(<CompactSummary content="tiny" compactedMessageCount={1} />);
    expect(
      screen.getByText(/streaming\.toolAction\.compact\.messagesCompacted\.one/),
    ).toBeInTheDocument();
  });

  it('is not expandable when the summary is empty', () => {
    render(<CompactSummary content="   " compactedMessageCount={4} />);
    expect(screen.getByTestId('chrome')).toHaveAttribute('data-can-expand', '0');
  });
});
