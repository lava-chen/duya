import type { RunEventEnvelope, RunId, SessionId } from '@duya/agent-protocol';
import { SurfaceModel } from '../surface/surface-model.js';

export interface RunSessionOptions {
  readonly runId: RunId;
  readonly sessionId: SessionId;
}

export type RunSessionAdmission =
  | { readonly status: 'applied'; readonly seq: number }
  | { readonly status: 'replayed'; readonly seq: number }
  | { readonly status: 'duplicate'; readonly seq: number }
  | { readonly status: 'wrong_run'; readonly seq: number }
  | { readonly status: 'wrong_session'; readonly seq: number }
  | { readonly status: 'invalid_seq'; readonly seq: number };

export type RunSessionWindowResult =
  | {
      readonly accepted: true;
      readonly applied: number;
      readonly duplicates: number;
      readonly lastAcceptedSeq: number;
    }
  | {
      readonly accepted: false;
      readonly reason: 'wrong_run' | 'wrong_session' | 'invalid_seq' | 'unordered';
    };

export interface RunSessionTimelineItem {
  readonly seq: number;
  readonly payload: RunEventEnvelope['payload'];
}

/** A stable, immutable view of one run, suitable for React and terminal clients. */
export interface RunSessionSnapshot {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly revision: number;
  /** Highest accepted Host cursor; sparse sequence values are valid. */
  readonly lastAcceptedSeq: number;
  /** Accepted native events in run sequence order, for ordered view projection. */
  readonly timeline: readonly RunSessionTimelineItem[];
  readonly run: SurfaceModel['runState'];
  readonly turns: SurfaceModel['turns'];
  readonly currentTurn: SurfaceModel['currentTurn'];
  readonly toolCalls: SurfaceModel['toolCalls'];
  readonly toolGroups: SurfaceModel['toolGroupSurfaces'];
  readonly permissions: SurfaceModel['permissions'];
  readonly subagents: SurfaceModel['subagents'];
  readonly messages: SurfaceModel['messages'];
  readonly compactions: SurfaceModel['compactions'];
  readonly checkpoints: SurfaceModel['checkpointLog'];
  readonly latestCheckpoint: SurfaceModel['latestCheckpointState'];
  readonly usage: SurfaceModel['usageState'];
  readonly mode: SurfaceModel['modeState'];
  readonly modeSource: SurfaceModel['modeSourceState'];
  readonly goal: SurfaceModel['goalState'];
  readonly status: SurfaceModel['statusState'];
  readonly hooks: SurfaceModel['hooksState'];
  readonly diagnostics: SurfaceModel['diagnosticsState'];
  readonly extensions: SurfaceModel['extensionsState'];
  readonly lastThresholdWarning: SurfaceModel['lastThresholdWarning'];
}

export type RunSessionListener = (snapshot: RunSessionSnapshot) => void;

/**
 * The client-side admission and projection boundary for one Host run.
 *
 * Sequence values identify events; they do not establish missing durable
 * records. Host windows are ordered but may be sparse because ephemeral events
 * are omitted. An unseen late event causes a sorted projection rebuild so its
 * reducer effects land in sequence order.
 */
export class RunSession {
  readonly runId: RunId;
  readonly sessionId: SessionId;

  readonly #events = new Map<number, RunEventEnvelope>();
  readonly #seen = new Set<number>();
  readonly #listeners = new Set<RunSessionListener>();
  #model = new SurfaceModel();
  #revision = 0;
  #lastAcceptedSeq = 0;
  #snapshot: RunSessionSnapshot;

  constructor(options: RunSessionOptions) {
    this.runId = options.runId;
    this.sessionId = options.sessionId;
    this.#snapshot = this.#createSnapshot();
  }

  getSnapshot(): RunSessionSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: RunSessionListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  apply(envelope: RunEventEnvelope): RunSessionAdmission {
    const rejected = this.#validate(envelope);
    if (rejected !== null) return rejected;
    if (this.#seen.has(envelope.seq)) return { status: 'duplicate', seq: envelope.seq };

    const isLate = envelope.seq < this.#lastAcceptedSeq;
    this.#seen.add(envelope.seq);
    this.#lastAcceptedSeq = Math.max(this.#lastAcceptedSeq, envelope.seq);

    if (envelope.payload.type !== 'diagnostic.trace') {
      const admitted = cloneFreeze(envelope);
      this.#events.set(envelope.seq, admitted);
      if (isLate) this.#rebuild();
      else this.#model.apply(admitted);
    }
    if (envelope.payload.type !== 'diagnostic.trace' || !isLate) this.#publish();
    return {
      status: isLate && envelope.payload.type !== 'diagnostic.trace' ? 'replayed' : 'applied',
      seq: envelope.seq,
    };
  }

  /** Accept one explicitly Host-ordered durable window atomically. */
  acceptWindow(envelopes: readonly RunEventEnvelope[]): RunSessionWindowResult {
    let previousSeq = 0;
    for (const envelope of envelopes) {
      const rejected = this.#validate(envelope);
      if (rejected !== null) return { accepted: false, reason: rejected.status };
      if (envelope.seq <= previousSeq) return { accepted: false, reason: 'unordered' };
      previousSeq = envelope.seq;
    }

    const previousHighWater = this.#lastAcceptedSeq;
    const newEvents: RunEventEnvelope[] = [];
    const projectionEvents: RunEventEnvelope[] = [];
    let duplicates = 0;
    for (const envelope of envelopes) {
      if (this.#seen.has(envelope.seq)) {
        duplicates += 1;
        continue;
      }
      const admitted = cloneFreeze(envelope);
      this.#seen.add(envelope.seq);
      newEvents.push(admitted);
      this.#lastAcceptedSeq = Math.max(this.#lastAcceptedSeq, envelope.seq);
      if (admitted.payload.type !== 'diagnostic.trace') {
        this.#events.set(envelope.seq, admitted);
        projectionEvents.push(admitted);
      }
    }

    if (projectionEvents.length > 0) {
      if (projectionEvents[0]!.seq < previousHighWater) this.#rebuild();
      else for (const envelope of projectionEvents) this.#model.apply(envelope);
    }
    if (newEvents.length > 0 && (projectionEvents.length > 0 || this.#lastAcceptedSeq !== previousHighWater)) {
      this.#publish();
    }
    return {
      accepted: true,
      applied: newEvents.length,
      duplicates,
      lastAcceptedSeq: this.#lastAcceptedSeq,
    };
  }

  #validate(envelope: RunEventEnvelope): Exclude<RunSessionAdmission, { status: 'applied' | 'replayed' | 'duplicate' }> | null {
    if (envelope.runId !== this.runId) return { status: 'wrong_run', seq: envelope.seq };
    if (envelope.sessionId !== this.sessionId) return { status: 'wrong_session', seq: envelope.seq };
    if (!Number.isSafeInteger(envelope.seq) || envelope.seq < 1) return { status: 'invalid_seq', seq: envelope.seq };
    return null;
  }

  #rebuild(): void {
    this.#model = new SurfaceModel();
    for (const envelope of [...this.#events.values()].sort((left, right) => left.seq - right.seq)) {
      this.#model.apply(envelope);
    }
  }

  #publish(): void {
    this.#revision += 1;
    this.#snapshot = this.#createSnapshot();
    let listenerFailed = false;
    let firstFailure: unknown;
    for (const listener of this.#listeners) {
      try {
        listener(this.#snapshot);
      } catch (error) {
        if (!listenerFailed) {
          listenerFailed = true;
          firstFailure = error;
        }
      }
    }
    if (listenerFailed) throw firstFailure;
  }

  #createSnapshot(): RunSessionSnapshot {
    const model = this.#model;
    const timeline = [...this.#events.values()]
      .sort((left, right) => left.seq - right.seq)
      .map(({ seq, payload }) => ({ seq, payload }));
    return cloneFreeze({
      runId: this.runId,
      sessionId: this.sessionId,
      revision: this.#revision,
      lastAcceptedSeq: this.#lastAcceptedSeq,
      timeline,
      run: model.runState,
      turns: model.turns,
      currentTurn: model.currentTurn,
      toolCalls: model.toolCalls,
      toolGroups: model.toolGroupSurfaces,
      permissions: model.permissions,
      subagents: model.subagents,
      messages: model.messages,
      compactions: model.compactions,
      checkpoints: model.checkpointLog,
      latestCheckpoint: model.latestCheckpointState,
      usage: model.usageState,
      mode: model.modeState,
      modeSource: model.modeSourceState,
      goal: model.goalState,
      status: model.statusState,
      hooks: model.hooksState,
      diagnostics: model.diagnosticsState,
      extensions: model.extensionsState,
      lastThresholdWarning: model.lastThresholdWarning,
    });
  }
}

function cloneFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneFreeze(item))) as T;
  }
  if (value !== null && typeof value === 'object') {
    const clone: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) clone[key] = cloneFreeze(child);
    return Object.freeze(clone) as T;
  }
  return value;
}
