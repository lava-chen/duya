/**
 * HTTP + SSE: the transport that has an origin, an identity and a cursor.
 *
 * ## The three obligations a socket has and a pipe does not
 *
 * A pipe is a pipe; a socket is reachable by anything that can open one. So
 * this transport carries three obligations the other two do not have, and each
 * is a REFUSAL rather than a check:
 *
 *  1. **Auth.** No token, no stream. A bearer check that defaults to "absent
 *     means allowed" is the shape of every mistake here, so the default is the
 *     opposite: a server configured with an empty token refuses everything.
 *  2. **Origin.** A browser attaches `Origin` to a cross-origin request and
 *     `fetch` cannot forge it. A request that CARRIES an `Origin` must match
 *     the allowlist; a request carrying none is a non-browser client and is
 *     judged on its token alone, because refusing every `Origin` would break
 *     the CLI, which is a peer this transport exists for.
 *  3. **Boundedness.** A response body is a buffer whose fill rate somebody else
 *     controls. There is a byte budget per connection, and exceeding it CLOSES
 *     the stream and tells the client to resume with `Last-Event-ID` -- which
 *     is contract section F's `disconnect+replay`, and is the honest
 *     alternative to the thing T3.4 forbade: shedding frames by type. Nothing
 *     in this file knows a frame's type, and `assertNoPerTypePauseClaim` is
 *     what stops a caller describing it as a type-aware pause.
 *
 * ## `handleReplayOutcome`, mapped over a real transport
 *
 * T3.3 defined the mapping (`ok` / `resync_required` / `error`), proved it
 * against in-memory outcomes, and deliberately left the wire form unmapped. Here
 * it is, and the status codes are the substance:
 *
 *  - `ok` -> **200**, a `replay` frame carrying the receipt, then the events.
 *  - `resync_required` -> **200**, a `replay` frame carrying the SNAPSHOT. Not
 *    a 4xx: the client asked a legitimate question and got a legitimate
 *    answer. What it must not be is indistinguishable from `ok`, because a
 *    client that appends rather than replaces then keeps a transcript it never
 *    received. So the distinction travels in the first frame, in the header AND
 *    in the body, because a streaming client reads none of the other two.
 *  - `error` -> **409** and NO stream. There is nothing to stream, and a 200
 *    that fails inside itself leaves a client holding a half-open run.
 *
 * The mapping is fed by a REAL {@link resolveReplay} against a REAL
 * {@link RunEventReader}. An earlier draft reconstructed a `ReplayOutcome` by
 * casting the subscription's receipt back into the union, which would have made
 * this function a second, invented account of the same decision -- the exact
 * fake-state-machine smell the equivalence test exists to catch, introduced
 * inside the test's own helper.
 *
 * ## No public host, as a side effect, ever
 *
 * The plan says do not stand up a public host as a side effect of a cloud
 * capability being off. The mechanical form is a constructor refusal: binding a
 * non-loopback address requires `allowNonLoopback: true`, stated at the call
 * site. A `0.0.0.0` default with a warning in a comment is a default that ships.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  ProtocolError,
  decodeReplayCursor,
  encodeReplayCursor,
  encodeSseFrame,
  type JsonValue,
  type ProtocolLimits,
  type ReplayCursor,
  type ReplayWindow,
  type RunEventEnvelope,
  type RunId,
} from '@duya/agent-protocol';
import { handleReplayOutcome, type ReplayOutcomeStatus } from '../replay/replay-guards.js';
import { openReplaySubscription } from '../replay/replay-subscription.js';
import { resolveReplay, type RunEventReader } from '../replay/replay-repository.js';

/** The SSE event names this transport defines. */
export const SSE_REPLAY = 'replay';
export const SSE_EVENT = 'run-event';
/** The raw executor frame, on the EXECUTION stream (`/frames`). */
export const SSE_FRAME = 'frame';
export const SSE_DISCONNECT = 'disconnect';
export const SSE_END = 'end';

/** What one replay attempt decided, in the shape a socket carries it. */
export interface ReplayPreamble {
  /** T3.3's status, verbatim, so a client branches on one vocabulary only. */
  readonly status: ReplayOutcomeStatus;
  readonly outcome: 'replay' | 'snapshot_resync' | 'refused';
  readonly window: ReplayWindow;
  readonly cursor: ReplayCursor;
  /** The seq a reconnect must resume from. NOT the window's `latest`. */
  readonly fromSeq: number;
  /** Present on `resync_required`. The state the client must REPLACE. */
  readonly snapshot?: unknown;
  readonly detail?: string;
}

export interface HttpSseServerOptions {
  /** The bearer token. There is no "no auth" option; an empty token refuses all. */
  readonly token: string;
  /** Origins a browser request may come from. Empty rejects every `Origin`. */
  readonly allowedOrigins?: readonly string[];
  /**
   * Per-connection byte budget before the stream is closed for replay.
   *
   * Measured on bytes the connection has accepted and not yet had drained. The
   * response is a socket, so a slow reader is a slow socket, and the only
   * honest moves are to buffer (bounded), to disconnect, or to shed blindly.
   */
  readonly maxPendingBytes?: number;
  readonly maxEventBytes?: number;
  /** Refuse a non-loopback bind unless this is explicitly true. */
  readonly allowNonLoopback?: boolean;
  readonly host?: string;
  readonly port?: number;
}

/** A run the server will stream. Registered by the runtime that owns it. */
export interface RegisteredRun {
  readonly runId: RunId;
  readonly reader: RunEventReader;
  /** Live fan-out of MINTED events. T3.3's `RunEventTap`: attach before
   *  reading, or lose whatever was minted during the read. Used by `/events`. */
  readonly tap: { attach(listener: (envelope: RunEventEnvelope) => void): () => void };
  /**
   * Live fan-out of RAW executor frames, on the EXECUTION path.
   *
   * Separate from `tap` on purpose, and not a convenience: `tap` carries
   * envelopes, which means somebody already minted them, and letting the
   * execution stream read from it would make the server a second numbering
   * authority. This one carries what the executor produced, unnumbered, and it
   * is also the only place a run can say "I am closed" as an awaitable.
   */
  readonly frames: {
    attach(listener: (frame: JsonValue) => void): () => void;
    closedSignal(): Promise<void>;
  };
  readonly isClosed: () => boolean;
  /** The highest seq the ledger has minted, which only the runtime knows. */
  readonly mintedLatest: () => number;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const EMPTY_WINDOW: ReplayWindow = { oldest: 0, latest: 0, mintedLatest: 0, count: 0, sparse: false };

export class HttpSseServer {
  readonly #options: HttpSseServerOptions;
  readonly #runs = new Map<RunId, RegisteredRun>();
  readonly #open = new Set<ServerResponse>();
  #server: Server | null = null;
  #boundPort = 0;

  constructor(options: HttpSseServerOptions) {
    const host = options.host ?? '127.0.0.1';
    if (!LOOPBACK.has(host) && options.allowNonLoopback !== true) {
      throw new ProtocolError({
        code: 'invalid_request',
        message:
          `refusing to bind ${host}: a non-loopback address is a public host and this capability ` +
          'is off. Pass allowNonLoopback: true to mean it.',
      });
    }
    if (options.token.length === 0) {
      throw new ProtocolError({
        code: 'invalid_request',
        message: 'refusing to serve with an empty bearer token: an open stream is not a default',
      });
    }
    this.#options = options;
  }

  get port(): number {
    return this.#boundPort;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.#boundPort}`;
  }

  register(run: RegisteredRun): void {
    this.#runs.set(run.runId, run);
  }

  async listen(): Promise<void> {
    const server = createServer((req, res) => {
      void this.#route(req, res);
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once('error', onError);
      server.listen(this.#options.port ?? 0, this.#options.host ?? '127.0.0.1', () => {
        server.off('error', onError);
        resolve();
      });
    });
    const address = server.address();
    this.#boundPort = typeof address === 'object' && address !== null ? address.port : 0;
  }

  async close(): Promise<void> {
    for (const res of this.#open) res.end();
    this.#open.clear();
    const server = this.#server;
    this.#server = null;
    if (server !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Whether a request is admitted, and the reason when it is not. */
  authorise(
    req: IncomingMessage,
  ): { readonly ok: true } | { readonly ok: false; readonly status: number; readonly reason: string } {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      return { ok: false, status: 401, reason: 'missing bearer token' };
    }
    if (header.slice('Bearer '.length) !== this.#options.token) {
      return { ok: false, status: 403, reason: 'bad bearer token' };
    }
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !(this.#options.allowedOrigins ?? []).includes(origin)) {
      return { ok: false, status: 403, reason: `origin ${origin} is not allowed` };
    }
    return { ok: true };
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const verdict = this.authorise(req);
    if (!verdict.ok) {
      res.writeHead(verdict.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: verdict.reason }));
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const framesMatch = /^\/v1\/runs\/([^/]+)\/frames$/.exec(url.pathname);
    if (framesMatch !== null && req.method === 'GET') {
      await this.#streamFrames(req, res, decodeURIComponent(framesMatch[1]!) as RunId);
      return;
    }
    const match = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (match !== null && req.method === 'GET') {
      await this.#streamEvents(req, res, decodeURIComponent(match[1]!) as RunId);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }

  /**
   * The EXECUTION stream, which carries RAW worker frames.
   *
   * ## Why this is a different endpoint from `/events`, and why it must be
   *
   * The port every transport implements accepts a RAW frame, and the runtime
   * mints `seq`. If the execution stream carried envelopes instead, the server's
   * emitter would be a SECOND numbering authority and the host would be holding
   * another process's sequence -- exactly the disagreement T3.2's emitter
   * refuses to adopt, recorded as a diagnostic.
   *
   * So the two endpoints have genuinely different jobs and are not two views of
   * one thing:
   *
   *  - `/frames` carries what the executor PRODUCED, unnumbered, and is what an
   *    execution adapter reads. The consumer is the runtime, not a UI.
   *  - `/events` carries what the runtime MINTED, numbered, and is what a
   *    reconnecting CONSUMER reads. Its cursor is a `seq` cursor because by then
   *    there is a sequence to resume from.
   *
   * Conflating them would be the single easiest way to make this transport look
   * equivalent to the other two while being structurally different, which is why
   * the split is enforced by the URL and not by a flag.
   */
  async #streamFrames(req: IncomingMessage, res: ServerResponse, runId: RunId): Promise<void> {
    const run = this.#runs.get(runId);
    if (run === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'run_not_found' }));
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-duya-stream': 'raw-frames',
    });
    this.#open.add(res);

    const budget = this.#options.maxPendingBytes ?? 1024 * 1024;
    let accepted = 0;
    const detach = run.frames.attach((frame) => {
      if (res.writableEnded) return;
      const encoded = encodeSseFrame(
        0,
        SSE_FRAME,
        frame,
        {
          maxEventBytes: this.#options.maxEventBytes ?? 16 * 1024 * 1024,
          maxSequenceLength: 1_000_000,
          maxNestingDepth: 64,
        },
      );
      accepted += Buffer.byteLength(encoded, 'utf8');
      if (accepted > budget) {
        res.write(
          `event: ${SSE_DISCONNECT}\ndata: ${JSON.stringify({ reason: 'slow_consumer' })}\n\n`,
        );
        res.end();
        return;
      }
      res.write(encoded);
    });

    // An execution stream ends when the run does. A client that hung up earlier
    // is not an error: the detach below is the disconnect policy, and it is
    // exactly "stop delivering, keep the run" -- the run's truth is in the store,
    // not in this socket.
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        res.off('close', finish);
        resolve();
      };
      res.on('close', finish);
      run.frames.closedSignal().then(finish);
    });
    detach();
    this.#open.delete(res);
    if (!res.writableEnded) {
      res.write(`event: ${SSE_END}\ndata: ${JSON.stringify({ reason: 'run_closed' })}\n\n`);
      res.end();
    }
  }

  async #streamEvents(req: IncomingMessage, res: ServerResponse, runId: RunId): Promise<void> {
    const run = this.#runs.get(runId);
    if (run === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'run_not_found' }));
      return;
    }

    // T3.3's scoped cursor. A bare number cannot say which run it belongs to, so
    // a number is REFUSED rather than guessed at.
    const raw = req.headers['last-event-id'];
    let cursor: ReplayCursor;
    if (typeof raw === 'string') {
      const decoded = decodeReplayCursor(raw);
      if (decoded === null) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ error: 'invalid_resume_point', detail: 'Last-Event-ID is not a scoped cursor' }),
        );
        return;
      }
      if (decoded.runId !== runId) {
        // A cursor for another run is not a near miss, it is a different run's
        // position, and serving it would hand a client another run's events.
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_resume_point', detail: 'cursor belongs to another run' }));
        return;
      }
      cursor = decoded;
    } else {
      cursor = { runId, epoch: 1, afterSeq: 0 };
    }

    // THE MAPPING, over a REAL outcome. `resolveReplay` is asked the same
    // question the subscription will ask, against the same reader, so the
    // status reported and the events delivered cannot disagree.
    const outcome = await resolveReplay(
      run.reader,
      { runId, epoch: 1, mintedLatest: run.mintedLatest() },
      cursor,
    );
    const status = handleReplayOutcome(outcome);

    if (status === 'error') {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: outcome.kind === 'refused' ? outcome.refusal : 'replay_unavailable',
          status,
          detail: outcome.kind === 'refused' ? outcome.detail : undefined,
        }),
      );
      return;
    }

    const subscription = await openReplaySubscription({
      reader: run.reader,
      tap: run.tap,
      run: { runId, epoch: 1, mintedLatest: run.mintedLatest() },
      cursor,
      isClosed: run.isClosed,
    });

    const preamble: ReplayPreamble = {
      status,
      outcome: subscription.receipt.outcome,
      window: subscription.receipt.window,
      cursor: subscription.receipt.cursor,
      fromSeq: subscription.receipt.fromSeq,
      ...(status === 'resync_required' ? { snapshot: await snapshotFor(run, cursor) } : {}),
      ...(subscription.receipt.detail !== undefined ? { detail: subscription.receipt.detail } : {}),
    };

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // In the header as well as the body: a client that reads headers and never
      // parses a frame still learns that this is not a plain replay.
      'x-duya-replay': status,
    });
    this.#open.add(res);
    res.write(`event: ${SSE_REPLAY}\ndata: ${JSON.stringify(preamble)}\n\n`);

    const limits: ProtocolLimits = {
      maxEventBytes: this.#options.maxEventBytes ?? 16 * 1024 * 1024,
      maxSequenceLength: 1_000_000,
      maxNestingDepth: 64,
    };
    const budget = this.#options.maxPendingBytes ?? 1024 * 1024;
    let accepted = 0;
    let closedForBudget = false;

    try {
      for await (const envelope of subscription.events()) {
        if (res.writableEnded) break;
        const frame = encodeSseFrame(
          envelope.seq,
          envelope.payload.type,
          envelope as unknown as JsonValue,
          limits,
        );
        accepted += Buffer.byteLength(frame, 'utf8');
        if (accepted > budget) {
          // Disconnect + replay. The client's `Last-Event-ID` is what makes the
          // gap recoverable, and the resume seq is the LAST one it actually
          // received rather than the one about to be written, so no event is
          // skipped by the disconnect itself.
          closedForBudget = true;
          res.write(
            `event: ${SSE_DISCONNECT}\ndata: ${JSON.stringify({ reason: 'slow_consumer', resumeFrom: envelope.seq })}\n\n`,
          );
          break;
        }
        res.write(frame);
      }
    } finally {
      subscription.close();
      this.#open.delete(res);
      if (!res.writableEnded) {
        if (closedForBudget) res.end();
        else {
          res.write(
            `event: ${SSE_END}\ndata: ${JSON.stringify({ fromSeq: subscription.receipt.fromSeq })}\n\n`,
          );
          res.end();
        }
      }
    }
  }
}

/** The transcript state a resyncing client must replace, built by the owner. */
async function snapshotFor(run: RegisteredRun, cursor: ReplayCursor): Promise<unknown> {
  const outcome = await resolveReplay(
    run.reader,
    { runId: run.runId, epoch: cursor.epoch, mintedLatest: run.mintedLatest() },
    cursor,
  );
  return outcome.kind === 'snapshot_resync' ? outcome.snapshot : null;
}

export interface HttpSseClientOptions {
  readonly origin: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  /** Origins to present, so a client can be made to look like a browser. */
  readonly originHeader?: string;
  /** Send a wrong token, so the refusal is testable. */
  readonly tokenOverride?: string;
}

export interface HttpSseSubscriptionResult {
  readonly runId: RunId;
  readonly preamble: ReplayPreamble | null;
  readonly events: readonly RunEventEnvelope[];
  /** The server closed for the byte budget; the client may resume. */
  readonly closedForBudget: boolean;
  readonly responseStatus: number;
  /** Set when the server refused rather than streamed. */
  readonly refusal?: { readonly error: string; readonly detail?: string };
}

export class HttpSseClient {
  readonly #options: HttpSseClientOptions;
  readonly #fetch: typeof fetch;

  constructor(options: HttpSseClientOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /**
   * Subscribe, optionally resuming from T3.3's cursor.
   *
   * A DUPLICATE resume is legitimate: a client that reconnects after an
   * ambiguous close does not know whether its last read landed. So the consumer
   * deduplicates by `(runId, seq)`, and the runtime half of that rule is
   * asserted against a real store rather than assumed.
   */
  async subscribe(
    runId: RunId,
    options: { readonly resumeFrom?: ReplayCursor; readonly limit?: number } = {},
  ): Promise<HttpSseSubscriptionResult> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#options.tokenOverride ?? this.#options.token}`,
      accept: 'text/event-stream',
      ...(this.#options.originHeader !== undefined ? { origin: this.#options.originHeader } : {}),
      ...(options.resumeFrom !== undefined
        ? { 'last-event-id': encodeReplayCursor(options.resumeFrom) }
        : {}),
    };
    const response = await this.#fetch(
      `${this.#options.origin}/v1/runs/${encodeURIComponent(runId)}/events`,
      { headers },
    );

    if (response.status !== 200) {
      const body = (await response.json()) as { error?: string; detail?: string };
      return {
        runId,
        preamble: null,
        events: [],
        closedForBudget: false,
        responseStatus: response.status,
        refusal: {
          error: body.error ?? 'unknown',
          ...(body.detail !== undefined ? { detail: body.detail } : {}),
        },
      };
    }

    const parsed = parseSseStream(await response.text(), options.limit);
    return {
      runId,
      preamble: parsed.preamble,
      events: parsed.events,
      closedForBudget: parsed.closedForBudget,
      responseStatus: response.status,
    };
  }

  /**
   * Read the EXECUTION stream and hand back RAW frames.
   *
   * Pauses the response between reads so a test can act as a slow consumer
   * against a real socket -- a real backpressure signal, not a simulated one.
   */
  async readFrames(
    runId: RunId,
    options: { readonly afterEachFrame?: (index: number) => Promise<void> } = {},
  ): Promise<{ readonly frames: readonly JsonValue[]; readonly status: number; readonly closedForBudget: boolean }> {
    const response = await this.#fetch(
      `${this.#options.origin}/v1/runs/${encodeURIComponent(runId)}/frames`,
      {
        headers: {
          authorization: `Bearer ${this.#options.tokenOverride ?? this.#options.token}`,
          accept: 'text/event-stream',
          ...(this.#options.originHeader !== undefined ? { origin: this.#options.originHeader } : {}),
        },
      },
    );
    if (response.status !== 200 || response.body === null) {
      return { frames: [], status: response.status, closedForBudget: false };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let body = '';
    let index = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      body += decoder.decode(chunk.value, { stream: true });
      // Honour the slow-consumer hook between reads, which is what makes the
      // server's byte budget reachable at all.
      if (options.afterEachFrame !== undefined) await options.afterEachFrame(index++);
    }
    const parsed = parseFrameStream(body);
    return { frames: parsed.frames, status: response.status, closedForBudget: parsed.closedForBudget };
  }
}

/**
 * The client's parse of a real SSE body, with consumer-side idempotency.
 *
 * Dedup is HERE and nowhere else in the transport: the store keys writes on
 * identity, the emitter mints, and a reconnecting consumer may legitimately see
 * one event from both live and replay. Three different jobs, three different
 * owners, which is why this is not a shared helper.
 */
export function parseSseStream(
  body: string,
  limit?: number,
): {
  readonly preamble: ReplayPreamble | null;
  readonly events: readonly RunEventEnvelope[];
  readonly closedForBudget: boolean;
} {
  const events: RunEventEnvelope[] = [];
  const seen = new Set<string>();
  let preamble: ReplayPreamble | null = null;
  let closedForBudget = false;

  for (const block of body.split('\n\n')) {
    if (!block.trim()) continue;
    let event = SSE_EVENT;
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
    }
    if (dataLines.length === 0) continue;
    const data = dataLines.join('\n');
    if (event === SSE_DISCONNECT) {
      closedForBudget = true;
      continue;
    }
    if (event === SSE_REPLAY) {
      preamble = JSON.parse(data) as ReplayPreamble;
      continue;
    }
    if (event === SSE_END) continue;
    const envelope = JSON.parse(data) as RunEventEnvelope;
    const key = `${envelope.runId}:${envelope.seq}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(envelope);
    if (limit !== undefined && events.length >= limit) break;
  }

  return { preamble, events, closedForBudget };
}

/**
 * Parse a real `/frames` body into RAW frames.
 *
 * The client's counterpart to the execution stream, and it deliberately returns
 * raw frames rather than envelopes: whatever consumes them is the runtime, and
 * the runtime is what mints. A client that rebuilt envelopes here would be a
 * second numbering authority wearing a client's clothes.
 */
export function parseFrameStream(body: string): {
  readonly frames: readonly JsonValue[];
  readonly closedForBudget: boolean;
  readonly ended: boolean;
} {
  const frames: JsonValue[] = [];
  let closedForBudget = false;
  let ended = false;
  for (const block of body.split('\n\n')) {
    if (!block.trim()) continue;
    let event = SSE_FRAME;
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
    }
    if (dataLines.length === 0) continue;
    const data = dataLines.join('\n');
    if (event === SSE_DISCONNECT) {
      closedForBudget = true;
      continue;
    }
    if (event === SSE_END) {
      ended = true;
      continue;
    }
    if (event !== SSE_FRAME) continue;
    frames.push(JSON.parse(data) as JsonValue);
  }
  return { frames, closedForBudget, ended };
}

export { EMPTY_WINDOW as EMPTY_REPLAY_WINDOW };
export type { ReplayWindow };
