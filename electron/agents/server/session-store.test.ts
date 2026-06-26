import { describe, expect, it } from 'vitest';
import { SessionManager } from './session-store';
import { SessionState } from './types';

describe('SessionManager.failSession', () => {
  it('moves a streaming session to ERROR and records retry metadata', () => {
    const manager = new SessionManager();
    manager.createSession('session-1');
    manager.transitionState('session-1', SessionState.STREAMING);

    manager.failSession('session-1', 'provider returned 500', true);

    expect(manager.getSession('session-1')).toMatchObject({
      state: SessionState.ERROR,
      errorMessage: 'provider returned 500',
      errorRetryable: true,
    });
  });

  it('allows an errored session to return to IDLE for the next chat', () => {
    const manager = new SessionManager();
    manager.createSession('session-1');
    manager.transitionState('session-1', SessionState.STREAMING);
    manager.failSession('session-1', 'provider returned 500', true);

    manager.transitionState('session-1', SessionState.IDLE);
    manager.transitionState('session-1', SessionState.STREAMING);

    expect(manager.getSession('session-1')?.state).toBe(SessionState.STREAMING);
  });

  it('also terminates errors raised while completing', () => {
    const manager = new SessionManager();
    manager.createSession('session-1');
    manager.transitionState('session-1', SessionState.STREAMING);
    manager.transitionState('session-1', SessionState.COMPLETING);

    manager.failSession('session-1', 'completion failed');

    expect(manager.getSession('session-1')?.state).toBe(SessionState.ERROR);
  });
});
