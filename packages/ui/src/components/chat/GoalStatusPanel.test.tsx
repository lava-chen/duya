// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { GoalStatusPanel } from './GoalStatusPanel';
import type { GoalUpdatedEvent } from '@/types/stream';

function goalEvent(overrides: Partial<GoalUpdatedEvent> = {}): GoalUpdatedEvent {
  return {
    state: 'active',
    phase: 'executing',
    objective: 'Ship the release',
    tokensUsed: 1200,
    tokenBudget: 0,
    consecutiveNotAchieved: 0,
    totalWorkerRounds: 4,
    totalVerifyRounds: 1,
    elapsedMs: 65_000,
    createdAt: Date.now() - 65_000,
    history: [
      { at: Date.now() - 60_000, event: 'start', detail: 'Ship the release' },
      { at: Date.now() - 30_000, event: 'verdict:not_achieved', reason: undefined },
    ],
    ...overrides,
  };
}

describe('GoalStatusPanel (plan 552 timeline)', () => {
  it('renders status, turn counter, and the event timeline', () => {
    render(<GoalStatusPanel goal={goalEvent()} onClose={() => {}} />);
    expect(screen.getByText('Ship the release')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('Turn 4')).toBeTruthy();
    expect(screen.getByText('Verify 1')).toBeTruthy();
    expect(screen.getByText('Started')).toBeTruthy();
    expect(screen.getByText('Not achieved')).toBeTruthy();
  });

  it('shows the pause reason next to the paused label', () => {
    render(
      <GoalStatusPanel
        goal={goalEvent({ state: 'user_paused', pauseReason: 'verifier_timeout' })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('Paused')).toBeTruthy();
    expect(screen.getByText('verification timed out')).toBeTruthy();
  });

  it('active goals offer Pause + Clear, paused goals offer Resume + Clear', () => {
    const active = render(<GoalStatusPanel goal={goalEvent()} onClose={() => {}} />);
    expect(screen.getByText('Pause')).toBeTruthy();
    expect(screen.queryByText('Resume')).toBeNull();
    active.unmount();

    render(
      <GoalStatusPanel
        goal={goalEvent({ state: 'blocked', pauseReason: 'blocked_worker' })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('Resume')).toBeTruthy();
    expect(screen.queryByText('Pause')).toBeNull();
  });

  it('an active verification wait replaces the status label (minimax parity)', () => {
    render(
      <GoalStatusPanel
        goal={goalEvent({ executionWait: 'verification' })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('Verifying the result')).toBeTruthy();
  });

  it('Pause sends the deterministic /goal pause command', () => {
    const sent: string[] = [];
    render(
      <GoalStatusPanel
        goal={goalEvent()}
        onClose={() => {}}
        onSendCommand={(cmd) => sent.push(cmd)}
      />,
    );
    fireEvent.click(screen.getByText('Pause'));
    expect(sent).toEqual(['/goal pause']);
  });
});
