/**
 * The session-level exits, tested over a FAKE worker.
 *
 * ## What is under test
 *
 * The executor is a forwarder, and the only thing worth proving about a
 * forwarder is that it forwards the RIGHT thing and reports the RIGHT refusal
 * for every way the forward can fail. A test that spawned a real worker would
 * prove none of that: it would prove that a worker exists, which is the
 * worker's business, not the executor's.
 *
 * So the fake port stands in for the worker: it records what was sent, and it
 * lets the test push the frames the real worker would push back.
 */

import { describe, expect, it } from 'vitest';
import {
  SessionCompactor,
  SessionSideQuestioner,
  type SessionCompactionLogger,
  type SessionCompactorPort,
  type SessionSideQuestionPort,
} from '../src/session-compaction.js';

interface FakePort extends SessionCompactorPort, SessionSideQuestionPort {
  /** The commands the executor sent, in order. */
  readonly sent: Array<{ sessionId: string; command: Record<string, unknown> }>;
  /** Push a raw worker frame to the executor's subscribers. */
  emit(sessionId: string, message: Record<string, unknown>): void;
  /** Make `sendCommand` report a delivery failure. */
  refuseDelivery(value: boolean): void;
  /** Make `hasWorker` report a missing worker. */
  loseWorker(value: boolean): void;
}

function fakePort(options: { busy?: boolean } = {}): FakePort {
  const listeners = new Set<(sessionId: string, message: Record<string, unknown>) => void>();
  const sent: Array<{ sessionId: string; command: Record<string, unknown> }> = [];
  let deliveryFails = false;
  let workerGone = false;
  return {
    sent,
    hasWorker: () => !workerGone,
    sendCommand: (sessionId, command) => {
      if (deliveryFails) return false;
      sent.push({ sessionId, command });
      return true;
    },
    onWorkerMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isSessionBusy: () => options.busy === true,
    emit: (sessionId, message) => {
      for (const listener of [...listeners]) listener(sessionId, message);
    },
    refuseDelivery: (value) => {
      deliveryFails = value;
    },
    loseWorker: (value) => {
      workerGone = value;
    },
  };
}

const silentLogger: SessionCompactionLogger = {
  info: () => undefined,
  warn: () => undefined,
};

describe('SessionCompactor', () => {
  it('forwards the compact command and reports the worker result', async () => {
    const port = fakePort();
    const compactor = new SessionCompactor(port, { logger: silentLogger });
    const reservation = compactor.reserve({ sessionId: 'session-1' });
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) return;

    const events: Array<{ event: string }> = [];
    const collected = (async () => {
      for await (const event of reservation.events) {
        events.push(event);
        if (event.event === 'compact:started') {
          port.emit('session-1', {
            type: 'compact:done',
            sessionId: 'session-1',
            result: { strategy: 'summary', tokensRemoved: 900, tokensRetained: 100, removedCount: 12 },
          });
        }
      }
    })();

    await collected;
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]?.command).toEqual({ type: 'compact', sessionId: 'session-1' });
    expect(events.map((event) => event.event)).toEqual(['compact:started', 'compact:completed']);
  });

  it('forwards the instructions as custom instructions', async () => {
    const port = fakePort();
    const compactor = new SessionCompactor(port, { logger: silentLogger });
    const reservation = compactor.reserve({ sessionId: 'session-1', instructions: 'keep the plan' });
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) return;

    const collected = (async () => {
      for await (const event of reservation.events) {
        if (event.event === 'compact:started') {
          port.emit('session-1', { type: 'compact:done', sessionId: 'session-1', result: {} });
        }
      }
    })();
    await collected;
    expect(port.sent[0]?.command).toEqual({
      type: 'compact',
      sessionId: 'session-1',
      customInstructions: 'keep the plan',
    });
  });

  it('reports worker_unreachable when the command cannot be delivered', async () => {
    const port = fakePort();
    port.refuseDelivery(true);
    const compactor = new SessionCompactor(port, { logger: silentLogger });
    const reservation = compactor.reserve({ sessionId: 'session-1' });
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) return;

    const events: Array<{ event: string; data: unknown }> = [];
    for await (const event of reservation.events) {
      events.push(event as { event: string; data: unknown });
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('compact:failed');
    expect(events[0]?.data).toMatchObject({ status: 'error', code: 'worker_unreachable' });
  });

  it('reports the worker error frame as a failure', async () => {
    const port = fakePort();
    const compactor = new SessionCompactor(port, { logger: silentLogger });
    const reservation = compactor.reserve({ sessionId: 'session-1' });
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) return;

    const events: Array<{ event: string; data: unknown }> = [];
    for await (const event of reservation.events) {
      if (event.event === 'compact:started') {
        port.emit('session-1', {
          type: 'compact:error',
          sessionId: 'session-1',
          message: 'Compaction failed: conversation is empty',
        });
      }
      events.push(event as { event: string; data: unknown });
    }
    expect(events.map((event) => event.event)).toEqual(['compact:started', 'compact:failed']);
    expect(events[1]?.data).toMatchObject({
      status: 'error',
      code: 'compaction_failed',
      message: 'Compaction failed: conversation is empty',
    });
  });

  it('times out instead of waiting forever', async () => {
    const port = fakePort();
    const compactor = new SessionCompactor(port, {
      logger: silentLogger,
      timeoutMs: 20,
      keepaliveMs: 5,
    });
    const reservation = compactor.reserve({ sessionId: 'session-1' });
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) return;

    const events: Array<{ event: string; data: unknown }> = [];
    for await (const event of reservation.events) {
      events.push(event as { event: string; data: unknown });
    }
    const terminal = events.at(-1);
    expect(terminal?.event).toBe('compact:failed');
    expect(terminal?.data).toMatchObject({ status: 'error', code: 'compact_timeout' });
  });

  it('refuses a busy session', () => {
    const compactor = new SessionCompactor(fakePort({ busy: true }), { logger: silentLogger });
    const reservation = compactor.reserve({ sessionId: 'session-1' });
    expect(reservation).toMatchObject({ ok: false, status: 409, code: 'session_busy' });
  });

  it('refuses a second compaction while one is in flight', async () => {
    const port = fakePort();
    const compactor = new SessionCompactor(port, { logger: silentLogger });
    const first = compactor.reserve({ sessionId: 'session-1' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = compactor.reserve({ sessionId: 'session-1' });
    expect(second).toMatchObject({ ok: false, status: 409, code: 'compact_in_flight' });

    // Draining the first reservation releases the slot.
    for await (const event of first.events) {
      if (event.event === 'compact:started') {
        port.emit('session-1', { type: 'compact:done', sessionId: 'session-1', result: {} });
      }
    }
    const third = compactor.reserve({ sessionId: 'session-1' });
    expect(third.ok).toBe(true);
  });

  it('refuses when no worker is alive', () => {
    const port = fakePort();
    port.loseWorker(true);
    const compactor = new SessionCompactor(port, { logger: silentLogger });
    const reservation = compactor.reserve({ sessionId: 'session-1' });
    expect(reservation).toMatchObject({ ok: false, status: 409, code: 'no_live_worker' });
  });

  it('releases the in-flight slot when the consumer stops early', async () => {
    const port = fakePort();
    const compactor = new SessionCompactor(port, { logger: silentLogger });
    const reservation = compactor.reserve({ sessionId: 'session-1' });
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) return;

    for await (const event of reservation.events) {
      if (event.event === 'compact:started') break;
    }
    const second = compactor.reserve({ sessionId: 'session-1' });
    expect(second.ok).toBe(true);
  });
});

describe('SessionSideQuestioner', () => {
  it('forwards the side question and returns the worker answer', async () => {
    const port = fakePort();
    const questioner = new SessionSideQuestioner(port, { logger: silentLogger });
    const pending = questioner.ask({ sessionId: 'session-1', question: 'what did we decide?' });
    await Promise.resolve();
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]?.command).toMatchObject({
      type: 'side:question',
      sessionId: 'session-1',
      question: 'what did we decide?',
    });
    const id = port.sent[0]?.command.id;
    port.emit('session-1', { type: 'side:answer', sessionId: 'session-1', id, answer: 'we ship on friday' });
    await expect(pending).resolves.toEqual({ answer: 'we ship on friday' });
  });

  it('rejects with the worker error', async () => {
    const port = fakePort();
    const questioner = new SessionSideQuestioner(port, { logger: silentLogger });
    const pending = questioner.ask({ sessionId: 'session-1', question: 'why?' });
    await Promise.resolve();
    const id = port.sent[0]?.command.id;
    port.emit('session-1', {
      type: 'side:answer',
      sessionId: 'session-1',
      id,
      answer: '',
      error: 'the model refused',
    });
    await expect(pending).rejects.toMatchObject({ status: 500, code: 'side_question_failed' });
  });

  it('rejects when the command cannot be delivered', async () => {
    const port = fakePort();
    port.refuseDelivery(true);
    const questioner = new SessionSideQuestioner(port, { logger: silentLogger });
    await expect(questioner.ask({ sessionId: 'session-1', question: 'why?' })).rejects.toMatchObject({
      status: 503,
      code: 'worker_unreachable',
    });
  });

  it('rejects when no worker is alive', async () => {
    const port = fakePort();
    port.loseWorker(true);
    const questioner = new SessionSideQuestioner(port, { logger: silentLogger });
    await expect(questioner.ask({ sessionId: 'session-1', question: 'why?' })).rejects.toMatchObject({
      status: 409,
      code: 'no_live_worker',
    });
  });

  it('times out instead of waiting forever', async () => {
    const port = fakePort();
    const questioner = new SessionSideQuestioner(port, { logger: silentLogger, timeoutMs: 20 });
    await expect(questioner.ask({ sessionId: 'session-1', question: 'why?' })).rejects.toMatchObject({
      status: 504,
      code: 'side_question_timeout',
    });
  });
});
