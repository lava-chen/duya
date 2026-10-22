/**
 * One live subscription to one Host run, projected through the shared surface.
 *
 * ## The single reducer rule
 *
 * `RunSession` is the only thing in this module that turns events into state.
 * This file owns a `RunSession`, feeds it envelopes, and forwards the snapshots
 * it publishes. It does not keep a parallel record of turns, tools or
 * permissions, because two reducers over one event stream disagree exactly when
 * the stream does something unusual — a late event, a replayed window, a
 * reconnect — and the disagreement is invisible until the screen shows two
 * different answers to the same question.
 *
 * ## What this file does own, and why
 *
 *  - The resume cursor. Every reconnect asks for `afterSeq = lastAcceptedSeq`,
 *    the highest sequence the surface actually admitted. Deriving it from the
 *    socket instead would re-deliver events the surface has seen (harmless,
 *    they dedupe) or skip the ones between (not harmless at all).
 *  - Batching. Frames that arrive in one chunk are admitted as one window, so a
 *    burst of deltas costs one projection pass rather than one per frame. A
 *    window is never a full replay; `acceptWindow` applies incrementally.
 *  - Liveness. The stream is expected to drop — a laptop sleeps, the Host
 *    restarts — so the loop reconnects with backoff and reports its own state.
 *    It never reports a run as finished on the strength of silence.
 *  - Scope. Everything is bound to the caller's `AbortSignal`, so changing the
 *    selected session tears this subscription down rather than leaving it to
 *    write into a selection that no longer exists.
 *
 * ## Why the transport is a body, not a URL
 *
 * The Desktop renderer cannot open an HTTP connection to the Host itself: the
 * Host's HTTP server refuses any request that carries an `Origin` header (a
 * CSRF defence), and a browser `fetch` from a `file://` page always carries
 * one. The Desktop therefore reaches the Host through an Electron bridge, and
 * that bridge hands over SSE bytes rather than a URL. Expressing the transport
 * as "give me a byte stream for this cursor" keeps ONE implementation of the
 * admission rules for both surfaces: the Web supplies a `fetch` body, the
 * Desktop supplies a bridge body, and neither supplies a reducer.
 */

import type { RunEventEnvelope, RunId, SessionId } from '@duya/agent-protocol';
import { RunSession, type RunSessionSnapshot } from './run-session.js';
import { decodeRunFrame, type IgnoredFrameReason } from '../decoding/envelope.js';
import { SseFrameDecoder } from '../decoding/sse.js';

export type RunStreamPhase =
  /** First subscription attempt, or a resubscribe after the cursor moved. */
  | 'connecting'
  /** The response is open and frames are being read. */
  | 'connected'
  /** The previous attempt ended and a new one is scheduled. */
  | 'reconnecting'
  /** Stopped on request. Nothing further will arrive. */
  | 'stopped';

export interface RunStreamState {
  readonly phase: RunStreamPhase;
  /** Consecutive failed attempts; reset to zero by an open response. */
  readonly attempt: number;
  /** The cursor the last request asked for. */
  readonly afterSeq: number;
  /** Host-reported stream failure code, when the stream reported one. */
  readonly hostError: string | null;
  /** Transport-level failure message, when the socket itself failed. */
  readonly transportError: string | null;
}

/**
 * Opens the run's event stream at a cursor.
 *
 * The returned body carries SSE bytes. It MUST NOT be decoded by the caller:
 * the framing, the UTF-8 handling and the admission rules all live in this
 * module, and a caller that decodes first has to reimplement them.
 */
export type RunStreamOpener = (
  runId: RunId,
  afterSeq: number,
  signal: AbortSignal,
) => Promise<ReadableStream<Uint8Array>>;

export interface RunEventStreamOptions {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  /**
   * The surface this stream feeds.
   *
   * Supplied when the CALLER owns the projection — the shared composition does,
   * because it also feeds the same surface from the durable ledger when the
   * bridge cannot stream. Omitted, the stream owns its own.
   */
  readonly session?: RunSession;
  /**
   * Opens the stream at a cursor and hands back SSE bytes.
   *
   * The transport is a PORT rather than a URL, because the Desktop renderer
   * cannot reach the Host's HTTP server at all (the Host refuses every request
   * carrying an `Origin` header). A surface that CAN reach it — the Web, over
   * its same-origin BFF — may use the `streamUrl` + `fetchImpl` pair below
   * instead, which is the same transport expressed the way a browser spells it.
   *
   * Exactly one of `openStream` and `streamUrl` is required.
   */
  readonly openStream?: RunStreamOpener;
  /** Builds the stream URL; supplied by `ApiClient` so routes live in one place. */
  readonly streamUrl?: (runId: RunId, afterSeq: number) => string;
  /** The `fetch` the `streamUrl` form uses. */
  readonly fetchImpl?: StreamFetchLike;
  /** Selection scope. Aborting it stops the subscription and its reconnects. */
  readonly signal: AbortSignal;
  /** First reconnect delay; each further attempt doubles it, capped at 30s. */
  readonly reconnectDelayMs?: number;
  /**
   * Reconnect after this long without a single frame. The Host emits a
   * keep-alive comment every 15s, so a window well above that measures a dead
   * socket rather than a quiet run. Zero disables the watchdog.
   */
  readonly stallTimeoutMs?: number;
  readonly onState?: (state: RunStreamState) => void;
  /** Called after a response body ended cleanly, after all decoded frames were admitted. */
  readonly onEnd?: () => void;
  /** Diagnostics only: frames and windows the surface refused. */
  readonly onRejected?: (detail: RejectedFrameDetail) => void;
}

/**
 * The `cache` values the DOM's `RequestInit` accepts.
 *
 * Spelled out instead of imported: `client-core` does not depend on the DOM
 * lib, and a widened `string` here would make the transport UNUSABLE from a
 * browser surface — a DOM `fetch` only accepts `RequestCache`, so a shared
 * transport promising an arbitrary string could not be handed a real `fetch`.
 */
export type StreamCacheMode =
  | 'default'
  | 'no-store'
  | 'no-cache'
  | 'reload'
  | 'force-cache'
  | 'only-if-cached';

/** The `fetch` the URL form of the transport uses. */
export type StreamFetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    cache?: StreamCacheMode;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly body: ReadableStream<Uint8Array> | null;
}>;

export interface RejectedFrameDetail {
  readonly reason: IgnoredFrameReason | 'wrong_run' | 'wrong_session' | 'invalid_seq' | 'unordered';
  readonly seq: number | null;
}

const DEFAULT_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
const DEFAULT_STALL_TIMEOUT_MS = 45_000;

export class RunEventStream {
  readonly #session: RunSession;
  readonly #options: RunEventStreamOptions;
  readonly #openStream: RunStreamOpener;
  readonly #unsubscribe: () => void;
  #state: RunStreamState;
  #stopped = false;
  #attemptController: AbortController | null = null;
  #pump: Promise<void> | null = null;

  constructor(options: RunEventStreamOptions) {
    this.#options = options;
    this.#session = options.session ?? new RunSession({ runId: options.runId, sessionId: options.sessionId });
    // Exactly one transport is required. A stream with NEITHER could only
    // fail later, at the first attempt, with a message about a missing body —
    // so it fails here, where the mistake is.
    if (options.openStream !== undefined) {
      this.#openStream = options.openStream;
    } else if (options.streamUrl !== undefined && options.fetchImpl !== undefined) {
      this.#openStream = (runId, afterSeq, signal) => openStreamByUrl(
        options.streamUrl as (runId: RunId, afterSeq: number) => string,
        options.fetchImpl as StreamFetchLike,
        runId,
        afterSeq,
        signal,
      );
    } else {
      throw new Error('RunEventStream needs either an openStream port or a streamUrl with a fetch');
    }
    this.#state = {
      phase: 'connecting',
      attempt: 0,
      afterSeq: 0,
      hostError: null,
      transportError: null,
    };
    // Snapshot publication is the surface's, not ours. A listener that throws is
    // re-thrown by `RunSession` and would otherwise stop the pump mid-frame.
    this.#unsubscribe = this.#session.subscribe(() => undefined);
    options.signal.addEventListener('abort', () => this.stop(), { once: true });
  }

  get session(): RunSession {
    return this.#session;
  }

  get state(): RunStreamState {
    return this.#state;
  }

  /** Delegate to the surface's own subscription; the snapshot identity is its own. */
  subscribe(listener: (snapshot: RunSessionSnapshot) => void): () => void {
    return this.#session.subscribe(listener);
  }

  getSnapshot(): RunSessionSnapshot {
    return this.#session.getSnapshot();
  }

  start(): void {
    this.#pump ??= this.#run();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#attemptController?.abort();
    this.#publish({ phase: 'stopped' });
    this.#unsubscribe();
  }

  /** Resolves when the subscription loop has fully exited. Test convenience. */
  async settled(): Promise<void> {
    await this.#pump;
  }

  async #run(): Promise<void> {
    let attempt = 0;
    while (!this.#stopped && !this.#options.signal.aborted) {
      const afterSeq = this.#session.getSnapshot().lastAcceptedSeq;
      this.#publish({ phase: attempt === 0 ? 'connecting' : 'reconnecting', attempt, afterSeq, transportError: null });

      const controller = new AbortController();
      this.#attemptController = controller;
      const onScopeAbort = (): void => controller.abort();
      this.#options.signal.addEventListener('abort', onScopeAbort, { once: true });
      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      let stalled = false;
      const armStallTimer = (): void => {
        if (stallTimer !== null) clearTimeout(stallTimer);
        const timeoutMs = this.#options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
        if (timeoutMs <= 0) return;
        stallTimer = setTimeout(() => {
          stalled = true;
          controller.abort();
        }, timeoutMs);
      };
      const stallMs = this.#options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
      if (stallMs > 0) armStallTimer();

      try {
        await this.#consume(controller.signal, afterSeq, () => {
          armStallTimer();
        });
        this.#options.onEnd?.();
        attempt = 0;
      } catch (error) {
        attempt += 1;
        if (this.#stopped || this.#options.signal.aborted || (isAbortError(error) && !stalled)) break;
        this.#publish({
          phase: 'reconnecting',
          attempt,
          afterSeq,
          transportError: stalled ? 'event_stream_stalled' : describeError(error),
        });
      } finally {
        if (stallTimer !== null) clearTimeout(stallTimer);
        this.#options.signal.removeEventListener('abort', onScopeAbort);
        this.#attemptController = null;
      }

      if (this.#stopped || this.#options.signal.aborted) break;
      const base = this.#options.reconnectDelayMs ?? DEFAULT_RECONNECT_MS;
      const wait = Math.min(base * 2 ** Math.max(0, attempt - 1), MAX_RECONNECT_MS);
      const completed = await delay(wait, this.#options.signal);
      if (!completed) break;
    }
    this.#publish({ phase: 'stopped' });
  }

  async #consume(signal: AbortSignal, afterSeq: number, onFrame: () => void): Promise<void> {
    const body = await this.#openStream(this.#options.runId, afterSeq, signal);
    this.#publish({ phase: 'connected', attempt: 0, afterSeq, transportError: null });
    const reader = body.getReader();
    const decoder = new SseFrameDecoder();
    // Frames decoded from ONE chunk are admitted as ONE window: the projection
    // runs once per read instead of once per frame.
    let window: RunEventEnvelope[] = [];
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        onFrame();
        if (chunk.value === undefined) continue;
        for (const frame of decoder.push(chunk.value)) {
          const decoded = decodeRunFrame(frame);
          if (decoded.kind === 'envelope') {
            window.push(decoded.envelope);
            continue;
          }
          if (decoded.kind === 'stream_error') {
            this.#publish({ hostError: decoded.code });
            continue;
          }
          this.#reject(decoded.reason, readFrameSeq(frame.id));
        }
        this.#admit(window);
        window = [];
      }
      decoder.end();
    } finally {
      try {
        await reader.cancel();
      } catch {
        // The stream is already closing; the attempt abort below releases it.
      }
      reader.releaseLock();
    }
  }

  /** Hand one window to the surface and report what it refused. */
  #admit(window: readonly RunEventEnvelope[]): void {
    if (window.length === 0) return;
    const result = this.#session.acceptWindow(window);
    if (result.accepted) return;

    // A window is refused as a unit, so nothing in it was applied. Replaying the
    // same envelopes one at a time still defers every decision to the surface —
    // duplicates stay duplicates and a foreign identity is still refused — but it
    // salvages the frames a strict window ordering could not accept.
    let refused = false;
    for (const envelope of window) {
      const admission = this.#session.apply(envelope);
      if (admission.status === 'wrong_run' || admission.status === 'wrong_session' || admission.status === 'invalid_seq') {
        this.#reject(admission.status, envelope.seq);
        refused = true;
      }
    }
    // Every frame was individually acceptable, so the window itself is what the
    // surface rejected. Report that rather than blaming a frame for an ordering
    // rule it did not break.
    if (!refused && result.reason === 'unordered') {
      this.#reject('unordered', window[window.length - 1]?.seq ?? null);
    }
  }

  #reject(reason: RejectedFrameDetail['reason'], seq: number | null): void {
    this.#options.onRejected?.({ reason, seq });
  }

  #publish(patch: Partial<RunStreamState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#options.onState?.(this.#state);
  }
}

/** The `id:` field as a sequence number, or `null` when it is not one. */
function readFrameSeq(id: string | null): number | null {
  if (id === null || !/^\d+$/.test(id)) return null;
  const value = Number(id);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Open the stream by URL, the way a browser spells it.
 *
 * The framing is NOT decoded here. The shared implementation owns that, and a
 * caller that decoded first would have to reimplement the UTF-8 handling and
 * the admission rules.
 */
async function openStreamByUrl(
  streamUrl: (runId: RunId, afterSeq: number) => string,
  fetchImpl: StreamFetchLike,
  runId: RunId,
  afterSeq: number,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const url = streamUrl(runId, afterSeq);
  const response = await fetchImpl(url, {
    method: 'GET',
    cache: 'no-store',
    headers: { accept: 'text/event-stream' },
    signal,
  });
  if (!response.ok) throw new Error(`event_stream_http_${response.status}`);
  const body = response.body;
  if (body === null) throw new Error('event_stream_missing_body');
  return body;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  return 'stream_failed';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Wait for `ms`, resolving early with `false` when the signal aborts. */
export function delay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
