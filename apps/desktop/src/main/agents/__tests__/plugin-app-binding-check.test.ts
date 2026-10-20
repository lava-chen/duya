import { describe, expect, it, vi } from 'vitest';
import {
  authorizePluginAppBindingCheck,
  parsePluginAppBindingCheckPayload,
} from '../plugin-app-binding-check';
import type { CommandSenderFacts } from '@duya/host/command-receipt';

/**
 * The final side-effect fence, on the Main side of the database bridge.
 *
 * A worker asks "is this binding still current?" immediately before it causes
 * the side effect. The answer may only come from a correlation the TRANSPORT
 * made — the body belongs to the worker, so a body that claims an attempt is
 * the worker's own claim about its own identity.
 */

const AGENT_SERVER: CommandSenderFacts = {
  senderPid: 4242,
  registeredSessionId: null,
  role: 'agent-server',
};

const TRUSTED = { sessionId: 'session-1', runId: 'run-1', epoch: 4 } as const;

const PAYLOAD = { bindingId: 'binding-1', nonce: 'nonce-1', toolId: 'mcp:dashboard/read' };

describe('parsePluginAppBindingCheckPayload', () => {
  it('reads the three fields a binding check names', () => {
    expect(parsePluginAppBindingCheckPayload(PAYLOAD)).toEqual(PAYLOAD);
  });

  it('refuses a payload carrying anything else', () => {
    expect(parsePluginAppBindingCheckPayload({ ...PAYLOAD, epoch: 9 })).toBeNull();
    expect(parsePluginAppBindingCheckPayload({ ...PAYLOAD, sessionId: 'other' })).toBeNull();
  });

  it('refuses a payload that is not three strings', () => {
    expect(parsePluginAppBindingCheckPayload({ bindingId: 1, nonce: 'n', toolId: 't' })).toBeNull();
    expect(parsePluginAppBindingCheckPayload({ bindingId: 'b' })).toBeNull();
    expect(parsePluginAppBindingCheckPayload(null)).toBeNull();
    expect(parsePluginAppBindingCheckPayload([PAYLOAD])).toBeNull();
  });
});

describe('authorizePluginAppBindingCheck', () => {
  it('checks the binding against the correlated attempt, not against the body', async () => {
    const isBindingCurrent = vi.fn(async () => true);

    const allowed = await authorizePluginAppBindingCheck({
      payload: PAYLOAD,
      sender: AGENT_SERVER,
      trustedAttempt: TRUSTED,
      isBindingCurrent,
    });

    expect(allowed).toBe(true);
    expect(isBindingCurrent).toHaveBeenCalledTimes(1);
    expect(isBindingCurrent).toHaveBeenCalledWith('binding-1', 'nonce-1', 'mcp:dashboard/read', {
      sessionId: 'session-1',
      runId: 'run-1',
      epoch: 4,
    });
  });

  it('refuses a request that carries no correlation at all', async () => {
    const isBindingCurrent = vi.fn(async () => true);

    const allowed = await authorizePluginAppBindingCheck({
      payload: PAYLOAD,
      sender: AGENT_SERVER,
      isBindingCurrent,
    });

    expect(allowed).toBe(false);
    expect(isBindingCurrent).not.toHaveBeenCalled();
  });

  it('refuses a sender that is not the Agent Server', async () => {
    const isBindingCurrent = vi.fn(async () => true);

    // A worker registered under a session is a different sender with a
    // different authority story.
    const registered = await authorizePluginAppBindingCheck({
      payload: PAYLOAD,
      sender: { senderPid: 77, registeredSessionId: 'session-1', role: 'chat' },
      trustedAttempt: TRUSTED,
      isBindingCurrent,
    });
    expect(registered).toBe(false);

    // The Agent Server role with a session registration is not the
    // Agent Server's own transport either.
    const mislabelled = await authorizePluginAppBindingCheck({
      payload: PAYLOAD,
      sender: { senderPid: 4242, registeredSessionId: 'session-1', role: 'agent-server' },
      trustedAttempt: TRUSTED,
      isBindingCurrent,
    });
    expect(mislabelled).toBe(false);

    const noRole = await authorizePluginAppBindingCheck({
      payload: PAYLOAD,
      sender: { senderPid: 4242, registeredSessionId: null, role: null },
      trustedAttempt: TRUSTED,
      isBindingCurrent,
    });
    expect(noRole).toBe(false);

    expect(isBindingCurrent).not.toHaveBeenCalled();
  });

  it('refuses a correlation that is not a well-formed attempt', async () => {
    const isBindingCurrent = vi.fn(async () => true);

    for (const attempt of [
      { sessionId: 'session-1', runId: '', epoch: 4 },
      { sessionId: '', runId: 'run-1', epoch: 4 },
      { sessionId: 'session-1', runId: 'run-1', epoch: Number.NaN },
      { sessionId: 'session-1', runId: 'run-1', epoch: 1.5 },
    ]) {
      const allowed = await authorizePluginAppBindingCheck({
        payload: PAYLOAD,
        sender: AGENT_SERVER,
        trustedAttempt: attempt,
        isBindingCurrent,
      });
      expect(allowed).toBe(false);
    }

    expect(isBindingCurrent).not.toHaveBeenCalled();
  });

  it('refuses a malformed body before it reaches the Host', async () => {
    const isBindingCurrent = vi.fn(async () => true);

    for (const payload of [null, { bindingId: 'b' }, { ...PAYLOAD, extra: 'x' }, [PAYLOAD]]) {
      const allowed = await authorizePluginAppBindingCheck({
        payload,
        sender: AGENT_SERVER,
        trustedAttempt: TRUSTED,
        isBindingCurrent,
      });
      expect(allowed).toBe(false);
    }

    expect(isBindingCurrent).not.toHaveBeenCalled();
  });

  it('answers with the refusal of the Host when the binding is no longer current', async () => {
    const isBindingCurrent = vi.fn(async () => false);

    const allowed = await authorizePluginAppBindingCheck({
      payload: PAYLOAD,
      sender: AGENT_SERVER,
      trustedAttempt: TRUSTED,
      isBindingCurrent,
    });

    expect(allowed).toBe(false);
    expect(isBindingCurrent).toHaveBeenCalledTimes(1);
  });
});
