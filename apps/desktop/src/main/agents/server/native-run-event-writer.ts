/**
 * native-run-event-writer.ts — the Desktop agent server's ONE durable writer
 * for Runtime-minted run events.
 *
 * ## Why Desktop needs its own
 *
 * `packages/host/src/run-execution.ts` supplies the same seam for the
 * standalone Host, over a `RunStore` it holds in process. The Desktop agent
 * server is a FORK and holds no database at all: its only durable path is
 * `db:request` to the Main process, which reaches the same `RunStore` through
 * the Control Plane service and the Host Run API adapter. Without this writer
 * the orchestrator refuses every native event with "this Host has no native
 * run event writer configured", and — since the legacy reverse-translation no
 * longer persists (15fa4850) — a Desktop chat turn writes a run row and no
 * events at all, silently.
 *
 * ## It IS fenced, and it fails closed
 *
 * The attempt the worker presents travels on the `run:append` payload and is
 * forwarded, unmodified, to `RunStore.appendEvents(envelopes, epoch)`. A
 * superseded attempt is refused there with `RunEpochFencedError`, and this
 * writer translates that refusal into the `fenced` outcome — the batch is
 * dropped, not retried and not blamed on another writer.
 *
 * `currentEpoch` is the one thing Desktop cannot read: it is a synchronous read
 * of the `runs` row and this process is not the one holding the connection.
 * Presenting attempt 0 — which is what a run created moments ago IS — is
 * therefore a REAL fence and not a bypass: the moment the row moves to another
 * attempt, every write from here is refused as `fenced`. The alternative,
 * presenting nothing, would be an unfenced writer that looks exactly as
 * correct; this one fails shut.
 */

import type { RunEventEnvelope } from '@duya/agent-protocol';
import { readRunReceipt, type RunWriteReceipt } from '@duya/host/run-receipt';
import type { NativeAppendOutcome, NativeRunEventWriter } from '@duya/host/run-orchestrator';

/** The `db:request` hop the agent server already uses for every durable call. */
export type DurableRunRequest = (action: string, payload: Record<string, unknown>) => Promise<unknown>;

export interface DesktopNativeWriterLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface DesktopNativeRunEventWriterOptions {
  readonly request: DurableRunRequest;
  readonly logger: DesktopNativeWriterLogger;
}

export function createDesktopNativeRunEventWriter(
  options: DesktopNativeRunEventWriterOptions,
): NativeRunEventWriter {
  return {
    // Attempt 0 is a fact, not a guess: a run row is created at epoch 0 and a
    // run this writer serves was created by the turn that is still executing.
    currentEpoch: () => 0,
    append: async (runId, envelopes, epoch) => {
      let reply: unknown;
      try {
        reply = await options.request('run:append', {
          runId,
          events: envelopes,
          epoch,
        });
      } catch (error) {
        return {
          state: 'failed',
          reason: `run:append could not reach the Control Plane: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      return toAppendOutcome(readRunReceipt(reply, 'run:append', runId), reply, envelopes, runId);
    },
  };
}

/**
 * Translate one `run:append` receipt into the outcome the orchestrator acts on.
 *
 * `written` is read off the RAW reply because the typed receipt does not carry
 * it — and it must not be defaulted: `0` means "every envelope in this batch was
 * already durable" (a retry) while a missing count means the peer is not
 * speaking this protocol. `readRunReceipt` has already refused the second case,
 * so by this point a numeric `written` is the only reading left.
 */
function toAppendOutcome(
  receipt: RunWriteReceipt,
  reply: unknown,
  envelopes: readonly RunEventEnvelope[],
  runId: string,
): NativeAppendOutcome {
  switch (receipt.state) {
    case 'applied': {
      const written = readWrittenCount(reply);
      return written > 0 ? { state: 'written', written } : { state: 'duplicate' };
    }
    case 'fenced':
      return { state: 'fenced', presented: receipt.presented, current: receipt.current };
    case 'conflict':
      // The Control Plane reports a contradicted identity, not the sequence
      // number it contradicted. Every append on this channel carries ONE
      // envelope (`persistNativeRunEvent`), so that envelope's own `seq` is
      // the sequence in dispute — and it is reported rather than invented.
      return { state: 'conflict', seq: envelopes[0]?.seq ?? 0 };
    default:
      return {
        state: 'failed',
        reason: `run:append was refused for run ${runId}: ${receipt.state}`,
      };
  }
}

function readWrittenCount(reply: unknown): number {
  if (typeof reply !== 'object' || reply === null) return 0;
  const written = (reply as { written?: unknown }).written;
  return typeof written === 'number' && Number.isFinite(written) ? written : 0;
}
