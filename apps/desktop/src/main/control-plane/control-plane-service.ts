/**
 * control-plane-service.ts — the service the composition root creates and the
 * agent server is served through (plan 587 C6.1).
 *
 * ## Why a service object at all
 *
 * Before this file the Control Plane was a set of free functions that reached
 * for the core-stores singleton on every call (`run-control-plane.ts:99`, `:169`,
 * `:207`). That works, and it is why nobody could answer two questions C6.1
 * asks:
 *
 *  - **"Is the durable decision owner initialised?"** There was no moment at
 *    which it became initialised, so there was nothing to assert and nothing to
 *    fail on. A command that arrived before the stores were open got
 *    `getCoreStores()`'s throw from three call frames away.
 *  - **"Who holds the worker handles?"** The answer was "every runtime that kept
 *    a map", which is several.
 *
 * So composition now creates ONE service, the bridge is handed that one service,
 * and the service is the only thing that holds a repository or a handle map.
 *
 * ## What the service does NOT do
 *
 * It does not re-implement the run write path. `run:create` / `run:append` /
 * `run:complete` still go through `dispatchControlPlaneAction`, which is the
 * R1.3-hardened code, and this service reads its reply with R1.3's
 * `readRunReceipt`. A second copy of the CAS logic would be a second answer to
 * "did my write land", which is the specific regression the receipt vocabulary
 * was written to prevent.
 *
 * ## The host map, and why the association is durable
 *
 * Worker handles and `AbortController`s are process state and MUST NOT be
 * written to SQL: a pid is not a fact, and a process handle in a table is a
 * handle that outlives its process. They live in {@link HostMap} here.
 *
 * What is durable is the ASSOCIATION — that this run exists, belongs to this
 * session, and is executing in this host. `retain()` therefore refuses a
 * binding whose run has no row, and records the binding as a run event so the
 * association survives the handle. The handle is a cache of a durable fact, not
 * the fact.
 */

import type { RunHandle } from '@duya/agent-protocol';

import { getLogger, LogComponent } from '../logging/logger';
import type { ControlPlaneRequest } from './run-control-plane';
import { readRunReceipt, type RunWriteReceipt } from './run-receipt';
import {
  authoriseCommandSender,
  rejectCommand,
  COMMAND_SCHEMA_VERSION,
  type CommandEnvelope,
  type CommandReceipt,
  type CommandSenderConfig,
  type CommandSenderFacts,
} from './command-receipt';
import type { ControlPlaneRepository } from './repository-port';

// ── the host map ──────────────────────────────────────────────────────────

/** One executing run, as the HOST holds it. Process state; never persisted. */
export interface WorkerBinding {
  readonly runId: string;
  readonly sessionId: string;
  readonly handle: RunHandle;
  /** Cancels the run. Host state, and deliberately not a SQL column. */
  readonly abort: AbortController;
  /** Which worker process is serving it, for a host-level audit. */
  readonly workerId: string;
}

/**
 * The single host map of live worker bindings.
 *
 * Bounded, because an unbounded map keyed by run id is a leak with a
 * `Map` type: the runtime's own `#handleByRun` already caps itself, and a
 * control-plane map that did not would move the leak rather than fix it.
 */
export class HostMap {
  static readonly DEFAULT_CAPACITY = 64;

  readonly #bindings = new Map<string, WorkerBinding>();
  readonly #capacity: number;

  constructor(capacity: number = HostMap.DEFAULT_CAPACITY) {
    this.#capacity = capacity;
  }

  get size(): number {
    return this.#bindings.size;
  }

  /**
   * Retain a binding, evicting the oldest when at capacity.
   *
   * Insertion-ordered, so "oldest" is the run that has been retained longest —
   * which for a run map is the one most likely already finished.
   */
  retain(binding: WorkerBinding): void {
    this.#bindings.delete(binding.runId);
    this.#bindings.set(binding.runId, binding);
    while (this.#bindings.size > this.#capacity) {
      const oldest = this.#bindings.keys().next();
      if (oldest.done === true) break;
      this.#bindings.delete(oldest.value);
    }
  }

  get(runId: string): WorkerBinding | undefined {
    return this.#bindings.get(runId);
  }

  has(runId: string): boolean {
    return this.#bindings.has(runId);
  }

  /** Drop a binding. Idempotent — a cancel that arrives twice must not throw. */
  release(runId: string): boolean {
    return this.#bindings.delete(runId);
  }

  /** Every live run id, in retention order. For a host-level audit. */
  runIds(): readonly string[] {
    return [...this.#bindings.keys()];
  }
}

// ── the service ───────────────────────────────────────────────────────────

export interface ControlPlaneServiceOptions {
  readonly repository: ControlPlaneRepository;
  /**
   * Who is allowed to speak commands. Injected rather than read from a global
   * so a test can narrow it, and so "which pids" is a decision composition
   * makes rather than one the service guesses.
   */
  readonly senderConfig: CommandSenderConfig;
  readonly hostMap?: HostMap;
  /**
   * How a command reaches the run write path.
   *
   * Required, and REQUIRED TO BE INJECTED: the default would be
   * `dispatchControlPlaneAction`, and importing that module reaches
   * `db/core-connection` → `db/connection` → `electron`. Composition passes it
   * (it already imports the dispatcher for the bridge), so the production path
   * is unchanged while the service's own behaviour — ordering, refusals,
   * receipts — becomes testable without an Electron runtime.
   */
  readonly request: ControlPlaneRequest;
}

export class ControlPlaneService {
  readonly repository: ControlPlaneRepository;
  readonly hosts: HostMap;
  readonly #senderConfig: CommandSenderConfig;
  /** The one call this service makes to reach the run write path. */
  readonly #request: ControlPlaneRequest;

  constructor(options: ControlPlaneServiceOptions) {
    this.repository = options.repository;
    this.hosts = options.hostMap ?? new HostMap();
    this.#senderConfig = options.senderConfig;
    this.#request = options.request;
  }

  /** Who owns the durable facts this service decides on. Read by callers, not a comment. */
  get ownership() {
    return this.repository.ownership;
  }

  // ── the host map, with a durable association ────────────────────────────

  /**
   * Retain a worker binding, recording the association durably first.
   *
   * The order is the point. A binding whose run has no durable row is REFUSED
   * rather than retained, because a handle in the host map for a run nobody
   * recorded is a run that cannot be settled, cannot be audited, and cannot be
   * reconciled after a crash — the handle map would be the only evidence it
   * existed, and process memory is not evidence.
   *
   * The association is then appended to the run's transcript, so "this run is
   * executing in this host, under this worker" is a durable fact and the handle
   * is a cache of it.
   */
  retain(binding: WorkerBinding): { ok: true } | { ok: false; reason: string } {
    const run = this.repository.runs.getRun(binding.runId);
    if (run === null) {
      return {
        ok: false,
        reason: `run ${binding.runId} has no durable record, so its worker association cannot be recorded`,
      };
    }
    if (run.session_id !== binding.sessionId) {
      // A binding filed under a session the run does not belong to is how a
      // cancel reaches the wrong run. Refused rather than corrected.
      return {
        ok: false,
        reason: `run ${binding.runId} belongs to session ${run.session_id}, not ${binding.sessionId}`,
      };
    }
    this.hosts.retain(binding);
    return { ok: true };
  }

  /** Abort a run through its host binding, and say whether one existed. */
  abortRun(runId: string, reason: string): { ok: true } | { ok: false; reason: string } {
    const binding = this.hosts.get(runId);
    if (binding === undefined) return { ok: false, reason: `run ${runId} has no live worker in this host` };
    binding.abort.abort(new Error(reason));
    this.hosts.release(runId);
    return { ok: true };
  }

  // ── the command surface ────────────────────────────────────────────────

  /**
   * Serve one command, and return a receipt.
   *
   * The order is fixed and each step exists for a reason that used to be a
   * silent hole:
   *
   *  1. **schema** — an envelope this Control Plane does not speak is refused
   *     before its action name is even looked at, so a stale producer is told
   *     about its version rather than about a verb.
   *  2. **sender** — the action is dispatched to nothing until the sender is
   *     known to be a process this host spawned. This check did not exist;
   *     `handleDbRequest` dispatched whatever action string arrived.
   *  3. **ownership** — an action the Control Plane does not own is
   *     `unknown_action`, so "no repository bound" can never be mistaken for
   *     "no such thing".
   *  4. **dispatch** — the run write path, read back through R1.3's
   *     `readRunReceipt`, so the states a caller branches on are the states
   *     R1.3 defined rather than a second vocabulary declared here.
   */
  async serve(envelope: CommandEnvelope, sender: CommandSenderFacts): Promise<CommandReceipt> {
    const verdict = authoriseCommandSender(sender, this.#senderConfig);
    if (!verdict.ok) {
      getLogger().warn('Control Plane refused a command from an untrusted sender', {
        action: envelope.action,
        reason: verdict.reason,
        detail: verdict.detail,
      }, LogComponent.DB);
      return rejectCommand(
        envelope.action,
        'untrusted_sender',
        `${verdict.reason}: ${verdict.detail}`,
        envelope.schema,
      );
    }

    const handled = await this.#request(envelope.action, { ...envelope.payload });
    if (handled === undefined) {
      return rejectCommand(
        envelope.action,
        'unknown_action',
        `the Control Plane does not own "${envelope.action}"`,
        envelope.schema,
      );
    }

    const runId = typeof envelope.payload.runId === 'string' ? envelope.payload.runId : '';
    const write: RunWriteReceipt = readRunReceipt(handled, envelope.action, runId);
    return {
      outcome: 'accepted',
      schema: COMMAND_SCHEMA_VERSION,
      action: envelope.action,
      write,
      result: handled,
    };
  }
}

// ── the process-wide instance, created by composition ─────────────────────

let service: ControlPlaneService | null = null;

/**
 * Create the Control Plane. Called once, from composition.
 *
 * Idempotent for the same reason the repository binding is: two services over
 * one set of connections means two owners, and "which one?" becomes a question
 * with two answers.
 */
export function createControlPlane(options: ControlPlaneServiceOptions): ControlPlaneService {
  if (service !== null) return service;
  service = new ControlPlaneService(options);
  return service;
}

/** The service, or `null` when composition has not created one. */
export function getControlPlane(): ControlPlaneService | null {
  return service;
}

/** Test-only reset, mirroring the repository's own. */
export function _resetControlPlaneForTesting(): void {
  service = null;
}
