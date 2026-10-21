import * as readline from 'node:readline';
import { logger } from './worker-logger.js';
import type { WorkerCommand } from '@duya/agent-protocol/worker-protocol';
export * from '@duya/agent-protocol/worker-protocol';
// Backpressure write queue (M10).
//
// Plan 583 / ISS-10: this was labelled "Bounded" but was an unbounded array —
// `sendEvent` pushed unconditionally, so a worker whose stdout consumer
// stalled grew the queue (and the heap) until the process died. Bound it on
// both frame count and approximate buffered bytes, and shed the OLDEST frames
// when over the cap: streaming consumers rebuild state from the newest
// events, and a terminal `chat:done` / `chat:error` at the tail is the last
// thing we want to lose.
const MAX_QUEUED_FRAMES = 2000;
const MAX_QUEUED_CHARS = 4 * 1024 * 1024;

const writeQueue: string[] = [];
let queuedChars = 0;
let isDraining = false;

function enqueue(frame: string): void {
  writeQueue.push(frame);
  queuedChars += frame.length;

  if (writeQueue.length <= MAX_QUEUED_FRAMES && queuedChars <= MAX_QUEUED_CHARS) return;

  // Shed from the front until both bounds hold again.
  let dropped = 0;
  while (
    writeQueue.length > MAX_QUEUED_FRAMES ||
    queuedChars > MAX_QUEUED_CHARS
  ) {
    const oldest = writeQueue.shift();
    if (oldest === undefined) break;
    queuedChars -= oldest.length;
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

function dequeue(): string | undefined {
  const frame = writeQueue.shift();
  if (frame !== undefined) queuedChars -= frame.length;
  return frame;
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
      canContinue = process.stdout.write(frame);
    } catch {
      // C3: Silently ignore — worker may be exiting. Drop this frame.
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
  let payload = JSON.stringify({ ...event, _logger: 'worker' });
  // M9: Escape embedded newlines to prevent event boundary corruption
  if (payload.includes('\n')) {
    payload = payload.replace(/\n/g, '\\n');
  }
  enqueue(payload + '\n');
  if (!isDraining) {
    processWriteQueue();
  }
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
