/**
 * Plan 600 S1a — the runId-keyed command boundary, and the ONE place the
 * session -> run indirection is written down.
 *
 * ## What the state of the world was before this file
 *
 * A run is already keyed by its own id. `RunManifest.runId` is minted by the
 * Control Plane, `RunSession` and `RunLedger` number events by `(runId, seq)`,
 * and `RunEventEnvelope.seq` is documented as unique *within a run* precisely
 * because a session outlives its runs. So the execution layer does NOT treat
 * Session as the identity root, and `00-contracts.md` §C's claim ("Run / Goal /
 * Task are rooted in their own ids, not in a `session_id` foreign key") is
 * already true of the runtime.
 *
 * What was NOT true of the runtime is the shape of its COMMAND surface. The
 * command that starts an execution still carried a required session key:
 *
 * ```ts
 * // execution-channel.ts, RunStartInput
 * interface RunStartInput { readonly sessionId: string; ... }
 * ```
 *
 * and the production host adapter read that field to address the executor
 * directly — `dispatch` and `interrupt` both took a `sessionId`, and
 * `WorkerManager` holds the worker in a map keyed by it. So the session -> run
 * mapping existed, but it existed *implicitly*, spread across three call sites
 * and one private map, and the runtime's own contract demanded the key from
 * every caller. `InProcessTransport` shows how little the runtime actually needs
 * it: it fabricates `sessionId: ''` (`in-process-transport.ts`), which is a
 * session key that names no session.
 *
 * ## The seam this file makes explicit
 *
 * Exactly one: **who resolves `runId` to an addressable executor, and when.**
 * This file is that resolver, and nothing else. It is a naming and refusal
 * boundary, not a second execution engine — see "What this file is NOT" below.
 *
 * Before: the caller passed a session key, and the host used it. After: the
 * caller passes a `runId`, this file looks the session up in a table it owns,
 * and REFUSES the run when there is no route rather than inventing a key.
 *
 * ## The `sessionId -> runId` table is TEMPORARY, and this is the reason
 *
 * `01-migration-map.md` §1.1 is explicit: the host adapter keeps this map "for
 * now", and the map is reversible. It exists because the workers are
 * per-session processes, and turning them into per-run processes is not a
 * boundary change — it is the S2/S3 worker rewrite. Claiming the runtime no
 * longer needs a session mapping would be a false claim while
 * `workerManager.sendCommand(sessionId, ...)` is still the only delivery path.
 *
 * **Deletion condition.** Delete this file when the executor is addressable by
 * `runId` alone. Concretely, when `WorkerManager` no longer keys workers by
 * `sessionId` and the desktop adapter's `dispatch`/`interrupt` take a `runId`.
 * Until then, the map is the price of not lying about the runtime's shape.
 *
 * ## What this file is NOT
 *
 * It holds no ledger, no `seq`, no emitter, no terminal decision and no
 * persistence handle, so it is not the "second engine" that
 * `transport-port.ts` warns a shared helper becomes when it acquires a little
 * state. The one piece of state it owns is *addressing*, which is host state by
 * definition, and it delegates the actual delivery to a host-supplied binding
 * that already exists. A transport that needs run state to work is a sign the
 * port is in the wrong place; this is the port, and it asks for no run state.
 *
 * ## Why the context is explicit and required
 *
 * History, attachments and workspace used to be reachable only by asking "which
 * session is this, and what does it have?". That is an implicit lookup of a
 * UI concept from the execution layer, which is the leak `00-contracts.md` §C
 * names. So {@link RunStartContext} states all three, and states them as
 * REQUIRED fields: an empty array means "none was supplied", which is a
 * different fact from "go and find it". Nothing here can perform a lookup,
 * because there is no lookup dependency to perform one through.
 *
 * {@link RunAttachmentRef} has no payload field on purpose. The contract
 * carries attachments by reference, and a type that cannot express 50 MB of
 * base64 makes the run layer structurally incapable of holding one — the same
 * reason `runInputRevision` hashes descriptors instead of bytes.
 */

import type { RunId, RunManifest, SessionId } from '@duya/agent-protocol';
import { runInputRevision } from '@duya/agent-protocol';
import {
  ExecutionDispatchError,
  type StopDisposition,
  type StopReceipt,
} from './execution-channel.js';

/**
 * One live binding between a run and the executor that will serve it.
 *
 * The `runId` is the run's own root identity and is never derived from the
 * session. The `sessionId` is the executor's ADDRESS, and it is the half of
 * this pair that is temporary — see the file header.
 */
export interface RunRoute {
  readonly runId: RunId;
  readonly sessionId: SessionId;
}

/** A prior turn, supplied rather than discovered. */
export interface RunHistoryEntry {
  readonly role: 'user' | 'assistant' | 'tool';
  readonly text: string;
}

/**
 * An attachment BY REFERENCE.
 *
 * No payload, no bytes, no base64. The host owns the object; the run names it.
 */
export interface RunAttachmentRef {
  readonly id: string;
  readonly name?: string;
  readonly type?: string;
  readonly url?: string;
}

/** Where the run is allowed to touch the filesystem, stated rather than assumed. */
export interface RunWorkspaceContext {
  readonly cwd: string;
  readonly workspaceId: string | null;
}

/**
 * Everything an execution needs, with nothing left to look up.
 *
 * All three groups are required. An optional field would make "the caller
 * forgot" and "the caller meant none" the same value, and the second reading is
 * the one that silently drops a user's history.
 */
export interface RunStartContext {
  readonly prompt: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly history: readonly RunHistoryEntry[];
  readonly attachments: readonly RunAttachmentRef[];
  readonly workspace: RunWorkspaceContext;
}

/** The resolved pair, handed to the host so it never resolves an id itself. */
export interface RunDispatchTarget extends RunRoute {}

/**
 * The resolved command, protocol-neutral.
 *
 * The host maps this onto its own wire format; this layer does not know what a
 * `chat:start` is, because that vocabulary belongs to the Desktop's legacy
 * worker and is not a run concept.
 */
export interface RunDispatchCommand {
  readonly prompt: string;
  /** `RunStartContext` folded into the option bag the executor already accepts. */
  readonly options: Readonly<Record<string, unknown>>;
  /** The protocol's own digest over `(sessionId, prompt, options)`. */
  readonly revision: string;
}

/**
 * What the host's existing stop path returns.
 *
 * Structural rather than an import, so this file stays free of the Desktop's
 * process pool — and structurally identical to what `WorkerManager` already
 * returns, so adopting it is a signature change and not an adapter.
 */
export interface HostStopOutcome {
  readonly accepted: boolean;
  readonly settled: Promise<StopDisposition>;
}

/** What `start` reports once a run is on the wire. */
export interface RunStartReceipt {
  readonly runId: RunId;
  /** Resolved here, not by the caller. */
  readonly sessionId: SessionId;
  readonly revision: string;
}

/**
 * Two routes wanted the same identity.
 *
 * Distinct from {@link ExecutionDispatchError} on purpose: a conflict is a
 * caller bug that must be fixed, while a refused dispatch is a normal outcome
 * the run layer turns into a terminal.
 */
export class RunRouteConflictError extends Error {
  readonly code = 'run_route_conflict' as const;

  constructor(reason: string) {
    super(`the run route is already taken: ${reason}`);
    this.name = 'RunRouteConflictError';
  }
}

/**
 * The explicit owner of `sessionId <-> runId`.
 *
 * ## The two invariants, and why they are not optional
 *
 * 1. **A run has at most one route.** Rebinding a live run would send its
 *    second turn to a different executor than its first, and the run's event
 *    sequence would then span two processes.
 * 2. **A session has at most one live run.** This is not this file's opinion:
 *    the production host already refuses a second run for a live session
 *    (`run-orchestrator.ts`, `openRun`) because the router's streaming guard
 *    lives in a different process from that map. Encoding it here keeps the
 *    invariant true for every caller rather than for the one that remembered.
 *
 * A `Map` on each side is deliberate — the lookup is O(1) on the hot path and
 * the table is short-lived (one entry per live run, released on settle).
 */
export class RunRouteTable {
  readonly #byRun = new Map<RunId, SessionId>();
  readonly #bySession = new Map<SessionId, RunId>();

  /** Bind a run to its executor. Throws rather than overwriting. */
  bind(route: RunRoute): void {
    const boundSession = this.#byRun.get(route.runId);
    if (boundSession !== undefined) {
      throw new RunRouteConflictError(
        `run ${route.runId} is already routed to session ${boundSession}`,
      );
    }
    const boundRun = this.#bySession.get(route.sessionId);
    if (boundRun !== undefined) {
      throw new RunRouteConflictError(
        `session ${route.sessionId} already has live run ${boundRun}`,
      );
    }
    this.#byRun.set(route.runId, route.sessionId);
    this.#bySession.set(route.sessionId, route.runId);
  }

  /** The session addressing this run, or `null` when it is not routable. */
  sessionFor(runId: RunId): SessionId | null {
    return this.#byRun.get(runId) ?? null;
  }

  /** The live run on this session, or `null`. */
  runFor(sessionId: SessionId): RunId | null {
    return this.#bySession.get(sessionId) ?? null;
  }

  /**
   * Drop a route. Returns whether there was one.
   *
   * Idempotent, because settle and crash-recovery both call it and neither can
   * know which ran first.
   */
  release(runId: RunId): boolean {
    const sessionId = this.#byRun.get(runId);
    if (sessionId === undefined) return false;
    this.#byRun.delete(runId);
    this.#bySession.delete(sessionId);
    return true;
  }

  /** How many live routes. Diagnostics and tests; not a control path. */
  get size(): number {
    return this.#byRun.size;
  }
}

/**
 * Fold the explicit context into the option bag the executor already accepts.
 *
 * The three groups are folded under stable keys rather than being passed
 * separately, for one reason that is not tidiness: `runInputRevision` hashes
 * `(sessionId, prompt, options)` and nothing else. A field that reached the
 * executor outside `options` would be invisible to the digest, and two turns
 * differing only in history would collide on the one property the digest exists
 * to decide. Folding them in means the single existing derivation covers them
 * with no second implementation.
 *
 * Attachment payloads are structurally impossible here — {@link RunAttachmentRef}
 * has no field to put one in — so the descriptors that reach the digest are
 * automatically the reference form the contract asks for.
 */
export function foldRunContext(context: RunStartContext): Readonly<Record<string, unknown>> {
  const options: Record<string, unknown> = { ...context.options };
  options['files'] = context.attachments.map((file) => {
    const ref: Record<string, unknown> = { id: file.id };
    if (file.name !== undefined) ref['name'] = file.name;
    if (file.type !== undefined) ref['type'] = file.type;
    if (file.url !== undefined) ref['url'] = file.url;
    return ref;
  });
  options['history'] = context.history.map((entry) => ({ role: entry.role, text: entry.text }));
  options['workspaceContext'] = {
    cwd: context.workspace.cwd,
    workspaceId: context.workspace.workspaceId,
  };
  return options;
}

/** What the host must supply. Both functions already exist on the host. */
export interface RunCommandRouterOptions {
  readonly routes: RunRouteTable;
  /** Address a resolved run. Returns false when nothing accepted the command. */
  readonly dispatch: (target: RunDispatchTarget, command: RunDispatchCommand) => boolean;
  /** The host's single existing stop path. `null` when there is nothing to stop. */
  readonly interrupt: (target: RunDispatchTarget, graceMs: number, reason: string) => HostStopOutcome | null;
}

/**
 * Commands in by `runId`; a resolved target out.
 *
 * The runtime's whole command surface is now runId-keyed, and the session
 * appears exactly once per command — as a value this class resolved, never as
 * one a caller supplied. Nothing else in the execution layer needs to know a
 * session exists.
 */
export class RunCommandRouter {
  readonly #options: RunCommandRouterOptions;

  constructor(options: RunCommandRouterOptions) {
    this.#options = options;
  }

  /** The table, so a host can bind and release alongside its own lifecycle. */
  get routes(): RunRouteTable {
    return this.#options.routes;
  }

  /**
   * Dispatch one execution, addressed by `manifest.runId`.
   *
   * @throws {ExecutionDispatchError} when the run has no route, or when the
   * host accepted nothing. The controller turns this into a terminal, so a
   * refused run never looks live.
   */
  start(manifest: RunManifest, context: RunStartContext): RunStartReceipt {
    const runId = manifest.runId;
    const sessionId = this.#options.routes.sessionFor(runId);
    if (sessionId === null) {
      // The refusal that this file exists to make possible. The alternative —
      // forwarding an empty or caller-supplied session — is what
      // `InProcessTransport` does today, and it produces a command addressed to
      // a session that does not exist.
      throw new ExecutionDispatchError(`run ${runId} has no executor route`);
    }
    const options = foldRunContext(context);
    const revision = runInputRevision({ sessionId, prompt: context.prompt, options });
    const target: RunDispatchTarget = { runId, sessionId };
    const accepted = this.#options.dispatch(target, {
      prompt: context.prompt,
      options,
      revision,
    });
    if (!accepted) {
      throw new ExecutionDispatchError(`no executor accepted the run ${runId}`);
    }
    return { runId, sessionId, revision };
  }

  /**
   * Stop a run, addressed by `runId`.
   *
   * Resolves the same route `start` bound, so the stop reaches the executor the
   * run actually started on rather than one named by the caller.
   *
   * A run with no route reports `unavailable` and does NOT call the host: there
   * is nothing to address, and reporting a cooperative stop for a stop that
   * touched nothing is the failure `StopDisposition` exists to prevent.
   */
  async stop(runId: RunId, request: { readonly graceMs: number; readonly reason: string }): Promise<StopReceipt> {
    const sessionId = this.#options.routes.sessionFor(runId);
    if (sessionId === null) {
      return { requested: false, disposition: 'unavailable', waitedMs: 0, reason: request.reason };
    }
    const outcome = this.#options.interrupt({ runId, sessionId }, request.graceMs, request.reason);
    if (outcome === null) {
      return { requested: false, disposition: 'unavailable', waitedMs: 0, reason: request.reason };
    }
    const disposition = await outcome.settled;
    return { requested: outcome.accepted, disposition, waitedMs: 0, reason: request.reason };
  }
}
