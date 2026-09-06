// @vitest-environment jsdom
/**
 * BotToolApprovalCard — Plan 498 durable approval card tests.
 *
 * Pending state renders the three-button action row; clicking fires
 * onResolve with the decision; answered states render a status pill
 * without actions and ignore further clicks.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BotToolApprovalCard } from '../bot/BotToolApprovalCard';

const t = (key: string) => key;

const APPROVAL = {
  approvalId: 'perm-9',
  toolName: 'send_email',
  toolInput: { to: 'a@b.c' },
};

describe('BotToolApprovalCard', () => {
  it('renders tool name, waiting pill and three actions when pending', () => {
    render(<BotToolApprovalCard approval={APPROVAL} status="pending" t={t} />);
    expect(screen.getByText('send_email')).toBeDefined();
    expect(screen.getByText('toolApproval.waiting')).toBeDefined();
    expect(screen.getByText('permission.deny')).toBeDefined();
    expect(screen.getByText('permission.allowOnce')).toBeDefined();
    expect(screen.getByText('permission.alwaysAllow')).toBeDefined();
  });

  it('clicking a button fires onResolve with the decision and disables the row', () => {
    const onResolve = vi.fn();
    render(<BotToolApprovalCard approval={APPROVAL} status="pending" onResolve={onResolve} t={t} />);
    fireEvent.click(screen.getByText('permission.alwaysAllow'));
    expect(onResolve).toHaveBeenCalledWith('perm-9', 'always');
    expect((screen.getByText('permission.deny') as HTMLButtonElement).disabled).toBe(true);
  });

  it('answered states show the status pill without actions', () => {
    render(<BotToolApprovalCard approval={APPROVAL} status="approved" t={t} />);
    expect(screen.getByText('toolApproval.approved')).toBeDefined();
    expect(screen.queryByText('permission.allowOnce')).toBeNull();
  });

  it('denied state shows the denied pill', () => {
    render(<BotToolApprovalCard approval={APPROVAL} status="denied" t={t} />);
    expect(screen.getByText('toolApproval.denied')).toBeDefined();
  });

  it('ignores clicks when not pending (busy guard)', () => {
    const onResolve = vi.fn();
    render(<BotToolApprovalCard approval={APPROVAL} status="consumed" onResolve={onResolve} t={t} />);
    // No buttons rendered at all in a terminal state.
    expect(screen.queryByRole('button')).toBeNull();
    expect(onResolve).not.toHaveBeenCalled();
  });
});
