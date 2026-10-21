import { describe, expect, it } from 'vitest';

// Snapshot the message listeners BEFORE the db client loads: it registers its
// own on import, and under a pool worker the pool has one too. Emitting
// `message` instead of calling the listener directly would re-enter the
// pool's deserializer, which is the very thing being guarded against here.
const PRE_EXISTING = new Set(process.listeners('message'));

const { sessionDb, setDbTransport } = await import('../src/worker-db-client.js');

const dbListener = process
  .listeners('message')
  .find((listener) => !PRE_EXISTING.has(listener)) as
  | ((message: unknown) => void)
  | undefined;

/**
 * T04b — the guarantee this file pins.
 *
 * A `db:request` is a plain object. In production it goes to the host over a
 * real IPC channel and that is fine. Under a vitest forks worker,
 * `process.send` is not the host's channel — it is the POOL's, and the pool's
 * deserializer calls `Buffer.from(message)` on whatever arrives. A plain object
 * there throws `ERR_INVALID_ARG_TYPE`, and the rejection is unhandled, so the
 * worker dies before the reporter prints a summary block. That is what kept
 * the CI `test` job red with no readable output at all.
 *
 * The old guard in this module was `if (!process.send) throw`, which cannot
 * catch it: in a pool worker `process.send` IS defined, it just is not ours.
 * These tests pin the replacement, and the load-bearing one is the refusal:
 * a test that forgets to install a transport must get a named, attributable
 * error, not a dead run.
 */
describe('worker-db-client transport boundary', () => {
  it('refuses to send over the pool channel instead of handing it a plain object', async () => {
    // Nothing is stubbed here on purpose. This is the exact state that used to
    // kill the run: no fake `process.send`, no transport installed.
    setDbTransport(null);

    // The refusal is a rejected promise, not a throw out of the module, so the
    // caller's own error handling still sees it.
    await expect(sessionDb.get('session-1')).rejects.toThrow(
      /refusing to send a db:request over process\.send/,
    );

    // And the message has to name the fix, or the failure just relocates the
    // debugging from "the run is dead" to "why won't my test import work".
    await expect(sessionDb.get('session-1')).rejects.toThrow(/setDbTransport/);
  });

  it('routes through an installed transport, so a test can answer requests', async () => {
    const sent: Array<{ id: string; action: string }> = [];
    setDbTransport({
      send: (request) => {
        const req = request as { id: string; action: string };
        sent.push({ id: req.id, action: req.action });
        setImmediate(() => {
          dbListener?.({
            type: 'db:response',
            id: req.id,
            success: true,
            result: { id: 'session-1', title: 'from the fake transport' },
          });
        });
      },
    });

    try {
      await expect(sessionDb.get('session-1')).resolves.toEqual({
        id: 'session-1',
        title: 'from the fake transport',
      });
      // The request really went through the injected channel — an assertion
      // about the resolved value alone would also pass if the module had
      // remembered some other path.
      expect(sent).toEqual([{ id: expect.any(String), action: 'session:get' }]);
    } finally {
      setDbTransport(null);
    }
  });

  it('preserves the process receiver when using the production send fallback', async () => {
    const originalSend = process.send;
    let receiver: unknown;
    const fallbackSend = function (this: NodeJS.Process, request: unknown): void {
      receiver = this;
      const req = request as { id: string };
      setImmediate(() => {
        dbListener?.({
          type: 'db:response',
          id: req.id,
          success: true,
          result: { id: 'session-1', title: 'from process.send' },
        });
      });
    };

    process.send = fallbackSend as typeof process.send;
    setDbTransport(null);
    try {
      await expect(sessionDb.get('session-1')).resolves.toEqual({
        id: 'session-1',
        title: 'from process.send',
      });
      expect(receiver).toBe(process);
    } finally {
      process.send = originalSend;
    }
  });

  it('goes back to refusing once the transport is removed', async () => {
    // Guards against a latch: if `setDbTransport(null)` only ever added a
    // fallback, the first refusal would be a one-time accident rather than
    // the standing rule.
    setDbTransport({ send: () => {} });
    setDbTransport(null);

    await expect(sessionDb.get('session-1')).rejects.toThrow(
      /refusing to send a db:request over process\.send/,
    );
  });
});
