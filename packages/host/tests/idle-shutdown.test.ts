import { describe, expect, it, vi } from 'vitest';
import { createIdleShutdown } from '../src/idle-shutdown.js';

function setup() {
  const log = { info: vi.fn(), warn: vi.fn() };
  const shutdown = vi.fn(async () => undefined);
  return { log, shutdown };
}

describe('createIdleShutdown', () => {
  it('stops immediately when no turn is running, without asking about a drain', async () => {
    const waitForSettle = vi.fn(async () => 'settled' as const);
    const { log, shutdown } = setup();
    const controller = createIdleShutdown({
      drainTimeoutMs: 1_000,
      isMidTurn: () => false,
      waitForSettle,
      shutdown,
      log,
    });

    controller.schedule();

    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(1));
    expect(waitForSettle).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('waits for a mid-turn worker to settle before closing the Host', async () => {
    let settle: (value: 'settled') => void = () => undefined;
    const order: string[] = [];
    const waitForSettle = vi.fn(() => new Promise<'settled'>((resolve) => {
      settle = (value) => { order.push('settled'); resolve(value); };
    }));
    const { log } = setup();
    const controller = createIdleShutdown({
      drainTimeoutMs: 5_000,
      isMidTurn: () => true,
      waitForSettle,
      shutdown: async () => { order.push('shutdown'); },
      log,
    });

    controller.schedule();
    await vi.waitFor(() => expect(waitForSettle).toHaveBeenCalledWith(5_000));
    expect(controller.waiting).toBe(true);
    expect(order).toEqual([]);

    settle('settled');

    await vi.waitFor(() => expect(order).toEqual(['settled', 'shutdown']));
    expect(controller.waiting).toBe(false);
    expect(log.info).toHaveBeenCalledWith(
      'Idle shutdown: waiting for the in-flight turn to settle',
      { timeoutMs: 5_000 },
    );
  });

  it('cancels a pending shutdown when a client reattaches during the wait', async () => {
    const waitForSettle = vi.fn(() => new Promise<'settled'>(() => undefined));
    const { log, shutdown } = setup(waitForSettle);
    const controller = createIdleShutdown({
      drainTimeoutMs: 5_000,
      isMidTurn: () => true,
      waitForSettle,
      shutdown,
      log,
    });

    controller.schedule();
    await vi.waitFor(() => expect(waitForSettle).toHaveBeenCalled());

    expect(controller.cancel()).toBe(true);
    expect(controller.waiting).toBe(false);
    await vi.waitFor(() => expect(log.info).toHaveBeenCalledWith(
      'Idle shutdown: a client reattached; staying up',
    ));
    expect(shutdown).not.toHaveBeenCalled();
    // Nothing is left to cancel once the verdict was withdrawn.
    expect(controller.cancel()).toBe(false);
  });

  it('closes anyway and warns when the turn outlives the drain cap', async () => {
    const { log, shutdown } = setup(vi.fn(async () => 'timeout' as const));
    const controller = createIdleShutdown({
      drainTimeoutMs: 250,
      isMidTurn: () => true,
      waitForSettle: async () => 'timeout',
      shutdown,
      log,
    });

    controller.schedule();

    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(1));
    expect(log.warn).toHaveBeenCalledWith(
      'Idle shutdown: the turn is still running after the drain cap',
      { timeoutMs: 250 },
    );
  });

  it('still closes when waiting for the turn cannot be observed', async () => {
    const { log, shutdown } = setup(vi.fn(async () => {
      throw new Error('registry unavailable');
    }));
    const controller = createIdleShutdown({
      drainTimeoutMs: 250,
      isMidTurn: () => true,
      waitForSettle: async () => {
        throw new Error('registry unavailable');
      },
      shutdown,
      log,
    });

    controller.schedule();

    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(1));
    expect(log.warn).toHaveBeenCalledWith(
      'Idle shutdown: could not wait for the turn to settle',
      { error: 'registry unavailable' },
    );
  });

  it('runs a second shutdown after a cancelled one, and ignores a third while closing', async () => {
    let settle: (value: 'settled') => void = () => undefined;
    let waits = 0;
    const waitForSettle = vi.fn(() => {
      waits += 1;
      return new Promise<'settled'>((resolve) => {
        settle = resolve;
      });
    });
    const { log, shutdown } = setup(waitForSettle);
    const controller = createIdleShutdown({
      drainTimeoutMs: 5_000,
      isMidTurn: () => true,
      waitForSettle,
      shutdown,
      log,
    });

    controller.schedule();
    await vi.waitFor(() => expect(waits).toBe(1));
    controller.cancel();
    await vi.waitFor(() => expect(controller.waiting).toBe(false));

    controller.schedule();
    await vi.waitFor(() => expect(waits).toBe(2));
    settle('settled');
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(1));

    controller.schedule();
    expect(waits).toBe(2);
    expect(controller.cancel()).toBe(false);
  });
});
