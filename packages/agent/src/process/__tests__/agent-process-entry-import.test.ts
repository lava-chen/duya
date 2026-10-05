/**
 * Plan 600 S2: the live chat path must be importable without booting it.
 *
 * agent-process-entry.ts used to call `void main()` at module scope and to
 * register seven process-level handlers there, so importing the file WAS
 * starting the process. That is what made the in-process live-turn claim
 * untestable. Two contracts hold the fix in place:
 *
 *   1. importing the module registers no process-level handler, and
 *   2. the start path consumes the INJECTED command stream, not process.stdin.
 *
 * Both tests import the entry DYNAMICALLY, never statically. A static import
 * is hoisted and evaluated before any test body runs, so the before/after
 * listener counts in contract 1 would bracket nothing and the assertion would
 * pass for the wrong reason.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

import type { WorkerCommand } from '../worker-protocol.js';

/**
 * The five handlers the entry used to register at module scope. Named
 * explicitly so a regression names the event that came back.
 */
const LIFECYCLE_EVENTS = [
  'SIGTERM',
  'SIGINT',
  'disconnect',
  'uncaughtException',
  'unhandledRejection',
] as const;

/** stdin events a readline consumer would attach to. */
const STDIN_EVENTS = ['data', 'readable', 'end', 'close', 'error'] as const;

type AnyListener = (...args: unknown[]) => void;

/** Every listener currently attached to `process`, keyed by event name. */
function processListenerSnapshot(): Map<string, Set<AnyListener>> {
  const snapshot = new Map<string, Set<AnyListener>>();
  for (const name of process.eventNames()) {
    snapshot.set(name, new Set(process.listeners(name) as unknown as AnyListener[]));
  }
  return snapshot;
}

function countOn(stream: NodeJS.ReadableStream | NodeJS.WritableStream, events: readonly string[]): number {
  return events.reduce((total, event) => total + stream.listenerCount(event), 0);
}

function stdinListenerCount(): number {
  return countOn(process.stdin, STDIN_EVENTS);
}

/**
 * Detach every listener this file caused to be added, so the production
 * handlers the start path installs on purpose cannot leak into the rest of the
 * suite. Scoped to the events the entry's start path actually touches: a
 * blanket sweep over `process.eventNames()` would also strip a listener the
 * runner itself added while the test was running.
 */
function restoreProcessListeners(snapshot: Map<string, Set<AnyListener>>): void {
  for (const event of LIFECYCLE_EVENTS) {
    const before = snapshot.get(event) ?? new Set<AnyListener>();
    for (const listener of process.listeners(event) as unknown as AnyListener[]) {
      if (!before.has(listener)) process.off(event, listener);
    }
  }
}

/** Resolve when `promise` settles or `ms` elapses, whichever comes first. */
async function settle(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([promise.then(() => undefined, () => undefined), deadline]);
  if (timer) clearTimeout(timer);
}

const listenersAtFileScope = processListenerSnapshot();
const originalSend = process.send;

afterEach(() => {
  vi.restoreAllMocks();
  process.send = originalSend;
  restoreProcessListeners(listenersAtFileScope);
});

describe('agent-process-entry import contract', () => {
  it('registers no process-level handler when the module is imported', async () => {
    // The entry's import GRAPH registers process handlers in its own account:
    //   message            -> initDbClient, src/ipc/db-client.ts:128 (module scope)
    //   SIGINT/SIGTERM/beforeExit -> CleanupRegistry.install,
    //     src/lifecycle/CleanupRegistry.ts:21-23, reached from
    //     src/lifecycle/BackgroundAgentLifecycle.ts:489 on a LATER tick
    // Those belong to other modules and are out of this slice, but they would
    // otherwise be indistinguishable from the entry's own five handlers in a
    // process-wide count. Loading them first empties the graph: every module
    // except the entry itself is already evaluated, so the only registrations
    // left in the window are the entry's. Do NOT resetModules after this.
    await import('../../ipc/db-client.js');
    await import('../../lifecycle/BackgroundAgentLifecycle.js');
    // Let the late-tick CleanupRegistry registrations land before snapshotting.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const before = processListenerSnapshot();
    const stdoutErrorsBefore = countOn(process.stdout, ['error']);
    const stderrErrorsBefore = countOn(process.stderr, ['error']);
    const stdinBefore = stdinListenerCount();

    await import('../agent-process-entry.js');

    // The general sweep: no event on `process` may have gained a listener.
    const after = processListenerSnapshot();
    const changed = [...after.keys()].filter(
      (name) => (after.get(name)?.size ?? 0) !== (before.get(name)?.size ?? 0),
    );
    expect(changed).toEqual([]);

    // And the five production handlers by name, so a regression is legible.
    // SIGINT and SIGTERM are among them on purpose: with the graph pre-loaded,
    // a count that moves here can only be the entry's own registration.
    for (const event of LIFECYCLE_EVENTS) {
      expect(process.listenerCount(event)).toBe(before.get(event)?.size ?? 0);
    }

    // The two output-stream handlers, which are the same class of side effect.
    expect(countOn(process.stdout, ['error'])).toBe(stdoutErrorsBefore);
    expect(countOn(process.stderr, ['error'])).toBe(stderrErrorsBefore);

    // No stdin consumer either: the loop must not have attached to the real pipe.
    expect(stdinListenerCount()).toBe(stdinBefore);
  }, 60_000);

  it('drives the command loop from the injected stream, not process.stdin', async () => {
    const { startAgentProcess } = await import('../agent-process-entry.js');

    // Keep the IPC channel out of the runner: sendToMain() calls
    // process.send?.(msg), and a real send here would speak vitest's protocol.
    const sendStub = vi.fn();
    process.send = sendStub as unknown as typeof process.send;

    const frames: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      frames.push(String(chunk));
      return true;
    }) as never);

    const listenersBefore = processListenerSnapshot();
    const stdinBefore = stdinListenerCount();

    let consumed = 0;
    const commands: AsyncIterable<WorkerCommand> = {
      async *[Symbol.asyncIterator]() {
        consumed += 1;
        yield { type: 'ping', sessionId: 'import-contract' } as unknown as WorkerCommand;
      },
    };

    await settle(startAgentProcess({ commands }), 2000);

    // The loop iterated the SUPPLIED stream, not the real pipe.
    expect(consumed).toBe(1);

    // The real handler ran for it: `ping` answers `pong` on both channels.
    expect(sendStub).toHaveBeenCalledTimes(1);
    const pong = frames
      .map((frame) => JSON.parse(frame) as { type?: string })
      .find((frame) => frame.type === 'pong');
    expect(pong).toBeDefined();

    // process.stdin was never consumed.
    expect(stdinListenerCount()).toBe(stdinBefore);

    // The production start path still installs the real lifecycle handlers —
    // this is the same function the entry calls, not a test-only variant.
    for (const event of LIFECYCLE_EVENTS) {
      expect(process.listenerCount(event)).toBe((listenersBefore.get(event)?.size ?? 0) + 1);
    }
  });
});
