import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { PluginAppTrustedAttemptStore } from '../plugin-app-trusted-attempts';
import { authorizePluginAppBindingCheck } from '../plugin-app-binding-check';

/**
 * The Main-side sideband store: the one place where a correlation the
 * transport made becomes authority for one request.
 *
 * The properties here are the ones a worker would have to break to turn a
 * Plugin App invocation into a side effect it was not granted: a correlation
 * belongs to the process that made it, and it authorises exactly one
 * request.
 */

function createChild(): ChildProcess {
  return Object.assign(new EventEmitter(), { killed: false, exitCode: null }) as unknown as ChildProcess;
}

const ATTEMPT = { sessionId: 'session-1', runId: 'run-1', epoch: 4 } as const;

describe('PluginAppTrustedAttemptStore', () => {
  it('hands a correlation to the request it was announced for, exactly once', () => {
    const store = new PluginAppTrustedAttemptStore();
    const child = createChild();

    expect(store.announce(child, 'req-1', ATTEMPT)).toBe(true);
    expect(store.consume(child, 'req-1')).toEqual(ATTEMPT);
    // A second request carrying the same id is a retry or a forgery, and
    // neither inherits the first one's authority.
    expect(store.consume(child, 'req-1')).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('refuses a correlation announced by one child to a request from another', () => {
    const store = new PluginAppTrustedAttemptStore();
    const announcing = createChild();
    const other = createChild();

    store.announce(announcing, 'req-1', ATTEMPT);

    // The other child's request does not get the correlation, and the
    // correlation is not consumed by the attempt.
    expect(store.consume(other, 'req-1')).toBeUndefined();
    expect(store.size).toBe(1);

    // The child that made the correlation still gets it.
    expect(store.consume(announcing, 'req-1')).toEqual(ATTEMPT);
  });

  it('releases only the correlations of the child that died', () => {
    const store = new PluginAppTrustedAttemptStore();
    const dying = createChild();
    const surviving = createChild();

    store.announce(dying, 'req-dying', ATTEMPT);
    store.announce(surviving, 'req-surviving', ATTEMPT);
    expect(store.size).toBe(2);

    store.release(dying);

    expect(store.size).toBe(1);
    expect(store.consume(dying, 'req-dying')).toBeUndefined();
    // The replacement Agent Server's correlation is a fact about a live
    // process and is still usable.
    expect(store.consume(surviving, 'req-surviving')).toEqual(ATTEMPT);
  });

  it('records nothing for an announcement that carries no usable attempt', () => {
    const store = new PluginAppTrustedAttemptStore();
    const child = createChild();

    expect(store.announce(child, 'req-empty', { sessionId: '', runId: 'run-1', epoch: 4 })).toBe(false);
    expect(store.announce(child, 'req-no-run', { sessionId: 'session-1', runId: '', epoch: 4 })).toBe(false);
    expect(store.announce(child, 'req-bad-epoch', { sessionId: 'session-1', runId: 'run-1', epoch: -1 })).toBe(false);
    expect(store.announce(child, 'req-fractional', { sessionId: 'session-1', runId: 'run-1', epoch: 1.5 })).toBe(false);

    expect(store.size).toBe(0);
    expect(store.consume(child, 'req-empty')).toBeUndefined();
  });

  it('accepts epoch zero, which is the epoch a first run is created under', () => {
    const store = new PluginAppTrustedAttemptStore();
    const child = createChild();

    expect(store.announce(child, 'req-zero', { sessionId: 'session-1', runId: 'run-1', epoch: 0 })).toBe(true);
    expect(store.consume(child, 'req-zero')).toEqual({ sessionId: 'session-1', runId: 'run-1', epoch: 0 });
  });

  it('holds nothing after every correlation was taken or released', () => {
    const store = new PluginAppTrustedAttemptStore();
    const child = createChild();

    for (let index = 0; index < 25; index += 1) {
      store.announce(child, `req-${index}`, { ...ATTEMPT, epoch: index });
    }
    expect(store.size).toBe(25);

    for (let index = 0; index < 25; index += 1) {
      expect(store.consume(child, `req-${index}`)).toEqual({ ...ATTEMPT, epoch: index });
    }
    expect(store.size).toBe(0);

    store.announce(child, 'req-late', ATTEMPT);
    store.release(child);
    expect(store.size).toBe(0);
  });
});

describe('PluginAppTrustedAttemptStore — the message the Agent Server sends', () => {
  /** The shape the Agent Server announces on. */
  function announcement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: 'desktop-plugin-app:trusted-attempt',
      id: 'req-1',
      sessionId: 'session-1',
      runId: 'run-1',
      epoch: 4,
      ...overrides,
    };
  }

  it('reads the correlation out of the announcement and pairs it with the child that sent it', () => {
    const store = new PluginAppTrustedAttemptStore();
    const child = createChild();

    expect(store.announceFromMessage(child, announcement())).toBe(true);
    expect(store.consume(child, 'req-1')).toEqual(ATTEMPT);
  });

  it('records nothing for an announcement that is not one', () => {
    const store = new PluginAppTrustedAttemptStore();
    const child = createChild();

    // No request id to pair the correlation with.
    expect(store.announceFromMessage(child, announcement({ id: 42 }))).toBe(false);
    // A half-formed attempt is refused rather than stored.
    expect(store.announceFromMessage(child, announcement({ sessionId: undefined }))).toBe(false);
    expect(store.announceFromMessage(child, announcement({ runId: null }))).toBe(false);
    expect(store.announceFromMessage(child, announcement({ epoch: 'four' }))).toBe(false);
    expect(store.announceFromMessage(child, announcement({ epoch: 1.5 }))).toBe(false);

    expect(store.size).toBe(0);
  });
});

describe('the Main side, end to end', () => {
  /** The Agent Server's sender facts, as the Main process builds them. */
  const SENDER = { senderPid: 4242, registeredSessionId: null, role: 'agent-server' } as const;

  it('turns an announcement and its request into one authorised binding check', async () => {
    const store = new PluginAppTrustedAttemptStore();
    const child = createChild();
    const seen: unknown[] = [];

    // The Agent Server announces the correlation it made.
    store.announceFromMessage(child, {
      type: 'desktop-plugin-app:trusted-attempt',
      id: 'req-1', sessionId: 'session-1', runId: 'run-1', epoch: 4,
    });

    // The request arrives, and takes the correlation with it. The body is the
    // worker's own and contributes nothing but the binding it names.
    const trustedAttempt = store.consume(child, 'req-1');
    const allowed = await authorizePluginAppBindingCheck({
      payload: { bindingId: 'binding-1', nonce: 'nonce-1', toolId: 'mcp:dashboard/read' },
      sender: SENDER,
      ...(trustedAttempt ? { trustedAttempt } : {}),
      isBindingCurrent: async (bindingId, nonce, toolId, caller) => {
        seen.push({ bindingId, nonce, toolId, caller });
        return true;
      },
    });

    expect(allowed).toBe(true);
    expect(seen).toEqual([{
      bindingId: 'binding-1',
      nonce: 'nonce-1',
      toolId: 'mcp:dashboard/read',
      caller: { sessionId: 'session-1', runId: 'run-1', epoch: 4 },
    }]);
  });

  it('refuses the same request when the correlation was already taken', async () => {
    const store = new PluginAppTrustedAttemptStore();
    const child = createChild();
    const isBindingCurrent = vi.fn(async () => true);

    store.announceFromMessage(child, {
      type: 'desktop-plugin-app:trusted-attempt',
      id: 'req-1', sessionId: 'session-1', runId: 'run-1', epoch: 4,
    });

    const first = store.consume(child, 'req-1');
    expect(first).toBeDefined();

    // The same request id arrives again. The correlation is gone, so the
    // request is refused for want of one.
    const second = store.consume(child, 'req-1');
    const allowed = await authorizePluginAppBindingCheck({
      payload: { bindingId: 'binding-1', nonce: 'nonce-1', toolId: 'mcp:dashboard/read' },
      sender: SENDER,
      ...(second ? { trustedAttempt: second } : {}),
      isBindingCurrent,
    });

    expect(allowed).toBe(false);
    expect(isBindingCurrent).not.toHaveBeenCalled();
  });
});
