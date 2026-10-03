/**
 * The narrow seam to whatever actually executes the run.
 *
 * ## Why this is an interface and not a `WorkerManager` import
 *
 * The runtime has to start an execution and receive its events, and it must be
 * able to do that without knowing whether the executor is a child process on
 * stdio, an HTTP endpoint, or a script in a test. Two reasons, in order of
 * weight:
 *
 *  1. **Testability without a process.** The Reference Run's closed loop has to
 *     be provable with no API key and no Electron. A structural interface lets
 *     a test supply a scripted executor and exercise the whole
 *     Control Plane → Runtime → RunEvent → SQLite path deterministically.
 *  2. **The executor is replaceable.** `@duya/agent` is the executor today.
 *     Rewriting the model loop, or moving it into a sandbox, must not require
 *     touching run identity, `seq`, or event persistence — that is the entire
 *     reason the run layer exists.
 *
 * So the seam is deliberately tiny: start, and receive frames. Everything the
 * executor cannot be asked for (cancel, pause, resume) is expressed in protocol
 * terms and handled by the controller, not delegated.
 *
 * ## Why `start` takes the MANIFEST (plan 587 R2.1)
 *
 * It used to take `(runId, sessionId, input, sink)`, which is a problem the
 * first real dispatch exposed: with the run id passed as a bare string, the
 * adapter could only forward an id, so the host kept issuing the executor's
 * command ITSELF and the run id travelled as a second, unrelated value. Two
 * dispatches, two ids, and a run whose executor was never told what it was
 * executing.
 *
 * `start(manifest, input, sink)` makes the run's whole identity and its
 * resolved configuration available at the ONE place an execution begins, so the
 * adapter can put the canonical `runId`, the manifest reference and the input
 * revision on the same wire message that starts the work. A host that also
 * sends its own command has two dispatches again, and the second one has no
 * manifest — which is why `RunController` calls this exactly once.
 */

import type { JsonObject, JsonValue, RunEventEnvelope, RunManifest } from '@duya/agent-protocol';
import { canonicalJson, sha256Hex } from '@duya/agent-protocol';
import type { RawFrame } from '../translate/chat-event-translator.js';

/** An execution started by the runtime. */
export interface ExecutionHandle {
  /**
   * Stop the execution. `graceMs` is the window in which a cooperative stop is
   * honoured before the caller escalates; the runtime never escalates on its
   * own, because only the host knows whether a hard kill is acceptable.
   *
   * Plan 587 R2.1 binds this to the host's EXISTING single interrupt function.
   * It deliberately does not add a second stop path and does not escalate: a
   * grace deadline that ends in a platform kill is R2.3's `ExecutionHandle.stop`
   * work, and adding it here would create the parallel path the plan forbids.
   */
  stop(graceMs: number): Promise<void>;
}

/** Receives frames from the executor as they are produced. */
export interface ExecutionSink {
  /**
   * One raw frame from the executor.
   *
   * Raw, not translated: the runtime owns translation so the event vocabulary
   * is a property of the run layer rather than of the transport. An executor
   * that already speaks the protocol may push envelopes through
   * {@link ExecutionSink.envelope} instead.
   */
  frame(raw: RawFrame): void;
  /** An event the runtime already built (a `run.started`, a synthetic failure). */
  envelope?(envelope: RunEventEnvelope): void;
  /** The executor's stream ended without a terminal frame. */
  end(): void;
}

/** Everything an executor needs to know about the turn it is about to run. */
export interface RunStartInput {
  readonly sessionId: string;
  readonly prompt: string;
  readonly options: Readonly<Record<string, unknown>>;
  /**
   * The digest that identifies THIS input, pinned before the execution began.
   *
   * Carried rather than recomputed by each side: the Control Plane writes it
   * into the run row, the adapter puts it on the executor's command, and a
   * later retry of the same run can compare against the row instead of
   * guessing whether "the same input" means the same bytes.
   */
  readonly revision: string;
}

/** What the runtime needs from an executor. */
export interface ExecutionChannel {
  /**
   * Begin an execution.
   *
   * @param manifest - The Control Plane's frozen decision about this run. The
   *   canonical `runId` is `manifest.runId`; an adapter that mints its own id
   *   here is a second run-identity source.
   * @param input - The resolved prompt, options, and the input revision.
   * @param sink - Where the executor reports. The controller guarantees
   *   `sink.end()` is safe to call more than once, so an executor does not have
   *   to track whether the run already settled.
   *
   * @throws {ExecutionDispatchError} when the executor is not available. The
   *   controller turns it into a terminal, so a refused dispatch leaves no run
   *   that looks live.
   */
  start(manifest: RunManifest, input: RunStartInput, sink: ExecutionSink): Promise<ExecutionHandle>;
}

/**
 * The executor refused to begin.
 *
 * Distinct from a generic throw so a host can tell "the worker was never there"
 * from "the adapter is broken". Both are refusals — neither started an
 * execution — but only one of them is fixed by spawning a worker, and a host
 * that cannot tell them apart retries the wrong thing.
 */
export class ExecutionDispatchError extends Error {
  /** Stable across hosts: the code a caller branches on. */
  readonly code = 'dispatch_refused' as const;

  constructor(reason: string) {
    super(`the executor refused to start the run: ${reason}`);
    this.name = 'ExecutionDispatchError';
  }
}

/**
 * The digest that identifies a run's input (plan 587 R2.1, contract §B).
 *
 * ## What is deliberately NOT hashed
 *
 * **Attachment payloads.** The contract carries attachments by REFERENCE — a
 * stored object id, not the bytes — and this digest has to respect that. A
 * chat turn may carry 50 MB of base64 (`DUYA_MAX_CHAT_PAYLOAD_SIZE`), and
 * canonicalising that into a string to hash it would make the run layer copy
 * every attachment in memory for a value that decides nothing about object
 * identity. What is hashed instead is the attachment DESCRIPTOR: how many, and
 * which ids. Two turns with the same five attachments hash the same; two turns
 * with different files do not, which is the property §C's "same manifest/input
 * may return the existing record, different content is refused" needs.
 *
 * ## Why it throws instead of guessing
 *
 * An input that cannot be canonicalised is a host bug, and the two convenient
 * alternatives are worse than a failure: dropping the field would let two
 * different inputs hash the same (a silent collision on the exact property this
 * digest exists for), and coercing it would hash a value the run never saw.
 * So it throws, and `RunController` reports the refusal as a start that was
 * not accepted.
 */
export function runInputRevision(input: {
  readonly sessionId: string;
  readonly prompt: string;
  readonly options: Readonly<Record<string, unknown>>;
}): string {
  const canonical = canonicalJson({
    sessionId: input.sessionId,
    prompt: input.prompt,
    options: asJson(optionsWithAttachmentRefs(input.options), 'options'),
  });
  return sha256Hex(canonical);
}

/**
 * Replace attachment payloads with their descriptor before hashing.
 *
 * Returns a new object; the caller's options are not touched, because the very
 * next thing that happens is the adapter handing those options to the executor
 * byte for byte.
 */
function optionsWithAttachmentRefs(
  options: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const files = options['files'];
  if (files === undefined) return { ...options };
  const rest: Record<string, unknown> = { ...options };
  delete rest['files'];
  rest['attachmentRefs'] = attachmentRefs(files);
  return rest;
}

/**
 * `{ count, ids }` for an attachment list, and `{ count: 0 }` for anything that
 * is not one.
 *
 * An id that is absent becomes `null` rather than being dropped, so the array's
 * LENGTH is preserved. Dropping it would make a one-attachment turn and a
 * two-attachment turn with no ids hash identically.
 */
function attachmentRefs(files: unknown): JsonObject {
  if (!Array.isArray(files)) return { count: 0 };
  return {
    count: files.length,
    ids: files.map((file) => {
      if (typeof file !== 'object' || file === null) return null;
      const id = (file as { readonly id?: unknown }).id;
      return typeof id === 'string' ? id : null;
    }),
  };
}

/**
 * Narrow an arbitrary option bag to something `canonicalJson` can serialise,
 * or fail loudly.
 *
 * `undefined` is dropped rather than rejected: `JSON.parse` never produces it,
 * but a host that spreads an object with an absent optional key does, and
 * refusing to start a chat over a key with no value would be absurd. Everything
 * else that is not JSON — a `Map` (which serialises to `{}` and would make a
 * populated map indistinguishable from an empty one, the exact trap
 * `manifest-factory.ts` documents), a function, a `Symbol`, `NaN` — is a
 * programming error and is named.
 */
function asJson(value: unknown, path: string): JsonValue {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`runInputRevision: ${path} is not a finite number`);
      return value;
    case 'undefined':
      return null;
    case 'object':
      break;
    default:
      throw new TypeError(`runInputRevision: ${path} is a ${typeof value}, which is not JSON`);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => asJson(item, `${path}[${index}]`));
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(
      `runInputRevision: ${path} is a ${value.constructor?.name ?? 'non-plain object'}, which has no canonical JSON form`,
    );
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (nested === undefined) continue;
    out[key] = asJson(nested, `${path}.${key}`);
  }
  return out;
}
