import * as readline from 'node:readline';
import { logger } from './worker-logger.js';
import type { WorkerCommand } from '@duya/agent-protocol/worker-protocol';
export * from '@duya/agent-protocol/worker-protocol';
// Backpressure write queue (M10).
//
// Plan 583 / ISS-10: this was labelled "Bounded" but was an unbounded array —
// `sendEvent` pushed unconditionally, so a worker whose stdout consumer
// stalled grew the queue (and the heap) until the process died. Bound it on
// both frame count and approximate buffered bytes. Disposable display frames
// can be shed under pressure; native run events cannot. If durable frames alone
// exhaust the bound, terminate the worker so the Host records failure.
const MAX_QUEUED_FRAMES = 2000;
const MAX_QUEUED_CHARS = 4 * 1024 * 1024;

interface QueuedFrame {
  readonly line: string;
  /** Native run envelopes are part of the durable transcript. */
  readonly mayDrop: boolean;
}

const writeQueue: QueuedFrame[] = [];
let queuedChars = 0;
let isDraining = false;
let transportFailed = false;

function enqueue(frame: string, mayDrop: boolean): void {
  writeQueue.push({ line: frame, mayDrop });
  queuedChars += frame.length;

  if (writeQueue.length <= MAX_QUEUED_FRAMES && queuedChars <= MAX_QUEUED_CHARS) return;

  // Shed the oldest incremental display frame until both bounds hold. If the
  // only frames left are control/result frames or native run events, stop the
  // worker: silently losing one could let the Host report an incomplete run.
  let dropped = 0;
  while (
    writeQueue.length > MAX_QUEUED_FRAMES ||
    queuedChars > MAX_QUEUED_CHARS
  ) {
    const oldestDisposable = writeQueue.findIndex((entry) => entry.mayDrop);
    if (oldestDisposable === -1) {
      failTransport();
      return;
    }
    const [oldest] = writeQueue.splice(oldestDisposable, 1);
    if (oldest === undefined) break;
    queuedChars -= oldest.line.length;
    dropped++;
  }
  if (dropped > 0) {
    logger.warn('[Worker-Protocol] stdout backlog over cap; dropped stale frames', {
      dropped,
      remaining: writeQueue.length,
      queuedChars,
    });
  }
}

function dequeue(): QueuedFrame | undefined {
  const frame = writeQueue.shift();
  if (frame !== undefined) queuedChars -= frame.line.length;
  return frame;
}

/**
 * A bounded queue cannot promise delivery after it runs out of disposable
 * frames. Exit non-zero so the Host's worker-exit path settles the run as a
 * failure instead of accepting a success whose durable event never arrived.
 */
function failTransport(): void {
  if (transportFailed) return;
  transportFailed = true;
  logger.error('[Worker-Protocol] stdout backlog exhausted non-disposable capacity; terminating worker');
  process.exit(70);
}

/**
 * `drain` handler. Must clear the in-flight flag before re-entering the pump,
 * which is guarded against re-entry — otherwise the resume call would bounce
 * straight back out and the queue would never drain.
 */
function onStdoutDrain(): void {
  isDraining = false;
  processWriteQueue();
}

function processWriteQueue(): void {
  if (isDraining) return;
  isDraining = true;
  for (;;) {
    const frame = dequeue();
    if (frame === undefined) break;
    let canContinue = false;
    try {
      canContinue = process.stdout.write(frame.line);
    } catch {
      // A failed write of an incremental display frame is harmless to the
      // durable run record. A failed control/result frame or native event
      // breaks the run contract, so fail the worker for the Host to observe.
      if (!frame.mayDrop) {
        failTransport();
        return;
      }
      continue;
    }
    if (!canContinue) {
      // M10: Park until the socket drains. Plan 583 / ISS-10: this must
      // happen whether or not frames remain. The old code only parked when
      // `writeQueue.length > 0`, but the loop had just drained the last frame,
      // so the condition was never true for a one-at-a-time producer and the
      // queue never actually built up — backpressure was dead and every event
      // went straight to stdout regardless of `write()`'s verdict. Parking
      // unconditionally is what makes later `sendEvent` calls queue up (and
      // therefore what makes the bound above meaningful).
      process.stdout.once('drain', onStdoutDrain);
      return;
    }
  }
  isDraining = false;
}

export function sendEvent(event: Record<string, unknown>): void {
  if (transportFailed) return;
  let payload = JSON.stringify({ ...event, _logger: 'worker' });
  // M9: Escape embedded newlines to prevent event boundary corruption
  if (payload.includes('\n')) {
    payload = payload.replace(/\n/g, '\\n');
  }
  enqueue(payload + '\n', isDisposableEvent(event));
  if (transportFailed) return;
  if (!isDraining) {
    processWriteQueue();
  }
}

/** Only incremental display updates may be discarded to recover from pressure. */
function isDisposableEvent(event: Record<string, unknown>): boolean {
  return event.type === 'chat:text_delta' ||
    event.type === 'chat:thinking_delta' ||
    event.type === 'chat:tool_use_delta';
}

export async function* parseStdin(): AsyncGenerator<WorkerCommand> {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const cmd = JSON.parse(line) as WorkerCommand;
      yield cmd;
    } catch {
      console.error('[Worker-Protocol] Failed to parse stdin line:', line.substring(0, 200));
    }
  }
}
