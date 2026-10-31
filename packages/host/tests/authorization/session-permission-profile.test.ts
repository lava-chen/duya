import { describe, expect, it } from 'vitest';

// Snapshot the message listeners BEFORE the db client loads: it registers its
// own on import, and under a pool worker the pool has one too.
const PRE_EXISTING = new Set(process.listeners('message'));

const { setDbTransport } = await import('../../src/worker-db-client.js');
const { readSessionPermissionProfile } = await import('../../src/authorization/session-permission-profile.js');

const dbListener = process
  .listeners('message')
  .find((listener) => !PRE_EXISTING.has(listener)) as
  | ((message: unknown) => void)
  | undefined;

/** Answer every `db:request` with `result`, on a later tick. */
function answerWith(result: unknown): { sent: Array<{ action: string }> } {
  const sent: Array<{ action: string }> = [];
  setDbTransport({
    send: (request) => {
      const req = request as { id: string; action: string };
      sent.push({ action: req.action });
      setImmediate(() => {
        dbListener?.({ type: 'db:response', id: req.id, success: true, result });
      });
    },
  });
  return { sent };
}

/**
 * The permission profile a session row carries.
 *
 * ## The failure this pins
 *
 * The worker asked the Host for the session row and read `permission_profile`
 * off the ANSWER without awaiting it. `sessionDb.get` is an IPC call, so the
 * answer is a Promise and the field was always `undefined` — which the bridge
 * reads as `default`. Every session therefore started under `default` no
 * matter what the row said, and the mode a person picked in the composer
 * never reached the agent.
 *
 * The read is behind a function so it can be tested without booting a worker
 * process; this file is what makes the await load-bearing.
 */
describe('the session row permission profile', () => {
  it('reads the profile the row carries', async () => {
    const { sent } = answerWith({
      id: 'session-1',
      permission_profile: 'full_access',
    });
    try {
      await expect(readSessionPermissionProfile('session-1')).resolves.toBe('full_access');
      expect(sent).toEqual([{ action: 'session:get' }]);
    } finally {
      setDbTransport(null);
    }
  });

  it('answers "auto" as itself, so the profile is not collapsed into a boolean', async () => {
    answerWith({ id: 'session-1', permission_profile: 'auto' });
    try {
      await expect(readSessionPermissionProfile('session-1')).resolves.toBe('auto');
    } finally {
      setDbTransport(null);
    }
  });

  it('reports no profile for a row that carries none', async () => {
    answerWith({ id: 'session-1' });
    try {
      await expect(readSessionPermissionProfile('session-1')).resolves.toBeNull();
    } finally {
      setDbTransport(null);
    }
  });

  it('reports no profile for a row that does not exist', async () => {
    answerWith(undefined);
    try {
      await expect(readSessionPermissionProfile('session-1')).resolves.toBeNull();
    } finally {
      setDbTransport(null);
    }
  });

  it('reports no profile when the Host cannot answer, instead of failing the turn', async () => {
    setDbTransport({
      send: (request) => {
        const req = request as { id: string };
        setImmediate(() => {
          dbListener?.({ type: 'db:response', id: req.id, success: false, error: 'no such session' });
        });
      },
    });
    try {
      await expect(readSessionPermissionProfile('session-1')).resolves.toBeNull();
    } finally {
      setDbTransport(null);
    }
  });
});
