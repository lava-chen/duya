/**
 * @vitest-environment jsdom
 *
 * Plan 437: HookActionRow component tests. Verifies that:
 *   - the collapsed chrome renders the hook event name + hook name
 *   - clicking the row expands the additionalContext card
 *   - the async badge appears for `async: true` hooks
 *   - the error path renders the error message in red
 *   - the verifier path renders the `[verify:<type>]` prefix
 *
 * The ActionRowChrome + StatusDot dependencies are stubbed so the
 * assertions stay focused on HookActionRow's own behavior, not the
 * shared chrome (which has its own tests).
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

vi.mock('../chrome/ActionRowChrome', () => ({
  ActionRowChrome: ({
    children,
    status,
    onClick,
    canExpand,
    icon,
    rightSlot,
  }: {
    children: React.ReactNode;
    status: string;
    onClick?: () => void;
    canExpand: boolean;
    icon?: React.ReactNode;
    rightSlot?: React.ReactNode;
  }) => (
    <div data-testid="chrome" data-status={status} data-can-expand={canExpand ? '1' : '0'}>
      {icon}
      <button data-testid="chrome-button" onClick={onClick}>
        {children}
      </button>
      {rightSlot}
    </div>
  ),
  StatusDot: ({ status }: { status: string }) => (
    <span data-testid="status-dot" data-status={status} />
  ),
}));

import { HookActionRow } from './HookActionRow';
import type { HookAction } from '@/types/hooks';

function makeHook(overrides: Partial<HookAction> = {}): HookAction {
  return {
    id: 'hook-1',
    hookEventName: 'PreToolUse',
    hookType: 'command',
    hookName: 'echo-block',
    async: false,
    durationMs: 42,
    status: 'ok',
    seq: 1,
    ...overrides,
  };
}

describe('HookActionRow', () => {
  it('renders collapsed chrome with hook event + hook name', () => {
    render(<HookActionRow hook={makeHook({ additionalContext: 'allowed' })} />);
    const chrome = screen.getByTestId('chrome');
    expect(chrome).toHaveAttribute('data-status', 'success');
    expect(chrome).toHaveAttribute('data-can-expand', '1');
    // Hook event name + hook name both visible.
    expect(screen.getByText('PreToolUse')).toBeInTheDocument();
    expect(screen.getByText('echo-block')).toBeInTheDocument();
    // additionalContext is NOT visible until expanded.
    expect(screen.queryByText('allowed')).not.toBeInTheDocument();
  });

  it('expands to show the additionalContext on click', () => {
    render(<HookActionRow hook={makeHook({ additionalContext: 'ctx-line-1' })} />);
    fireEvent.click(screen.getByTestId('chrome-button'));
    expect(screen.getByText('ctx-line-1')).toBeInTheDocument();
  });

  it('renders the async badge for async hooks', () => {
    render(
      <HookActionRow
        hook={makeHook({
          async: true,
          backgroundTaskId: 'task-7',
          additionalContext: undefined,
        })}
      />,
    );
    // The badge uses the i18n key (mocked to the key itself).
    expect(screen.getByText('streaming.toolAction.hook.async')).toBeInTheDocument();
    // Click → expand → background task id is shown.
    fireEvent.click(screen.getByTestId('chrome-button'));
    expect(screen.getByText('task:task-7')).toBeInTheDocument();
  });

  it('renders the verifier prefix when the hook exited non-zero', () => {
    render(
      <HookActionRow
        hook={makeHook({
          additionalContext: 'lint failed: missing semicolon',
          exitCode: 2,
        })}
      />,
    );
    fireEvent.click(screen.getByTestId('chrome-button'));
    expect(
      screen.getByText(/streaming\.toolAction\.hook\.verifierPrefix/),
    ).toBeInTheDocument();
    expect(screen.getByText('lint failed: missing semicolon')).toBeInTheDocument();
  });

  it('renders the error message when the hook status is error', () => {
    render(
      <HookActionRow
        hook={makeHook({
          status: 'error',
          errorMessage: 'spawn failed: ENOENT',
          additionalContext: undefined,
        })}
      />,
    );
    fireEvent.click(screen.getByTestId('chrome-button'));
    expect(
      screen.getByText(/streaming\.toolAction\.hook\.errorPrefix/),
    ).toBeInTheDocument();
    expect(screen.getByText('spawn failed: ENOENT')).toBeInTheDocument();
  });

  it('renders the timeout prefix when the hook timed out', () => {
    render(
      <HookActionRow
        hook={makeHook({
          status: 'timeout',
          errorMessage: 'killed after 60s',
          additionalContext: undefined,
        })}
      />,
    );
    fireEvent.click(screen.getByTestId('chrome-button'));
    expect(
      screen.getByText(/streaming\.toolAction\.hook\.timeout/),
    ).toBeInTheDocument();
  });

  it('is not expandable when there is nothing to show (silent ok)', () => {
    // A successful hook with no stdout and no async task id has
    // nothing to reveal — the row stays collapsed and quiet rather
    // than rendering an empty placeholder.
    render(
      <HookActionRow
        hook={makeHook({
          status: 'ok',
          additionalContext: undefined,
          errorMessage: undefined,
          async: false,
        })}
      />,
    );
    expect(screen.getByTestId('chrome')).toHaveAttribute('data-can-expand', '0');
  });

  it('uses success status for skipped hooks (no user-facing error)', () => {
    render(
      <HookActionRow
        hook={makeHook({
          status: 'skipped',
          errorMessage: 'circuit breaker open',
          additionalContext: undefined,
        })}
      />,
    );
    expect(screen.getByTestId('chrome')).toHaveAttribute('data-status', 'success');
  });
});