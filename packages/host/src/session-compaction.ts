/**
 * Session-level exits: manual compaction and side questions.
 *
 * ## Why this file exists
 *
 * Both operations already live INSIDE the worker process. The worker's
 * `compact` command hydrates the timeline, asks the summarizer to rewrite it
 * and rebases the journal; its `side:question` command snapshots the
 * conversation and answers it with one tool-free LLM call. Neither creates a
 * run.
 *
 * What was missing was the EXIT: a route a client that can only speak HTTP
 * can reach. This file is that exit's implementation — a thin forwarder over
 * the worker commands that already exist. It does NOT reimplement compaction
 * or side-question logic.
 *
 * ## Why the port is narrow
 *
 * The executor talks to a worker through four operations and nothing else:
 * is there a worker, can I send it a command, can I hear its frames, and is
 * the session busy. Anything wider would make this untestable without
 * spawning a real worker process, and the compaction path is exactly the kind
 * of code that must be testable in isolation.
 */

import { randomUUID } from 'node:crypto';
import type {
  HostSessionCompactionApiV1,
  HostSessionSideQuestionApiV1,
  SessionCompactEvent,
  SessionCompactInput,
  SessionCompactReservation,
  SessionCompactResult,
} from '@duya/agent-protocol';

/** The worker-facing operations the executor needs. Nothing more. */
export interface SessionCompactorPort {
  /** Whether a live worker process exists for this session. */
  hasWorker(sessionId: string): boolean;
  /** Deliver a command to the session's worker. `false` = not delivered. */
  sendCommand(sessionId: string, command: Record<string, unknown>): boolean;
  /** Subscribe to raw worker frames. Returns an unsubscribe function. */
  onWorkerMessage(listener: (sessionId: string, message: Record<string, unknown>) => void): () => void;
  /** Whether the session currently has an unsettled run. */
  isSessionBusy(sessionId: string): boolean;
}

/** The worker-facing operations the side questioner needs. */
export interface SessionSideQuestionPort {
  hasWorker(sessionId: string): boolean;
  sendCommand(sessionId: string, command: Record<string, unknown>): boolean;
  onWorkerMessage(listener: (sessionId: string, message: Record<string, unknown>) => void): () => void;
}

/** Structured logging boundary, owned by the composing Host process. */
export interface SessionCompactionLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

const NOOP_LOGGER: SessionCompactionLogger = {
  info: () => undefined,
  warn: () => undefined,
};

/** How long a compaction may take before the executor gives up on it. */
export const DEFAULT_COMPACT_TIMEOUT_MS = 10 * 60 * 1000;
/** How often a keepalive frame is emitted while a compaction is running. */
export const DEFAULT_COMPACT_KEEPALIVE_MS = 15 * 1000;
/** How long a side question may take before the request fails. */
export const DEFAULT_SIDE_QUESTION_TIMEOUT_MS = 120 * 1000;

export interface SessionCompactorOptions {
  readonly timeoutMs?: number;
  readonly keepaliveMs?: number;
  readonly logger?: SessionCompactionLogger;
}

export interface SessionSideQuestionerOptions {
  readonly timeoutMs?: number;
  readonly logger?: SessionCompactionLogger;
}

/** A refusal the route must answer with a status and a structured code. */
export class HostSessionCompactionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HostSessionCompactionError';
  }
}

type CompactOutcome =
  | { readonly kind: 'done'; readonly result: Extract<SessionCompactResult, { status: 'ok' }> }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string };

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the worker's `compact:done` payload into the session-level result.
 *
 * The worker reports the strategy, the token delta and how many messages it
 * removed. The remaining message count is not on that frame: it is reported by
 * the `chat:token_usage` frame the worker pushes right before `compact:done`,
 * so the executor tracks the last one it saw and falls back to zero.
 */
function readCompactDone(
  frame: Record<string, unknown>,
  fallbackMessageCount: number,
): Extract<SessionCompactResult, { status: 'ok' }> {
  const result = isRecord(frame.result) ? frame.result : frame;
  const messageCount = readFiniteNumber(result.messageCount) ?? fallbackMessageCount;
  return {
    status: 'ok',
    strategy: typeof result.strategy === 'string' ? result.strategy : 'unknown',
    tokensRemoved: readFiniteNumber(result.tokensRemoved) ?? 0,
    tokensRetained: readFiniteNumber(result.tokensRetained) ?? 0,
    removedCount: readFiniteNumber(result.removedCount) ?? 0,
    messageCount,
  };
}

/**
 * Session-level manual compaction.
 *
 * The compaction itself happens in the worker process; this class forwards
 * the `compact` command, waits for the worker's answer, and turns the two
 * differently-shaped worker frames into ONE result shape (see
 * `SessionCompactResult`) so the union never leaks to a client.
 */
export class SessionCompactor implements HostSessionCompactionApiV1 {
  readonly #port: SessionCompactorPort;
  readonly #timeoutMs: number;
  readonly #keepaliveMs: number;
  readonly #logger: SessionCompactionLogger;
  /** Sessions with a compaction in flight. One compaction per session. */
  readonly #inFlight = new Set<string>();

  constructor(port: SessionCompactorPort, options: SessionCompactorOptions = {}) {
    this.#port = port;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_COMPACT_TIMEOUT_MS;
    this.#keepaliveMs = options.keepaliveMs ?? DEFAULT_COMPACT_KEEPALIVE_MS;
    this.#logger = options.logger ?? NOOP_LOGGER;
  }

  reserve(input: SessionCompactInput): SessionCompactReservation {
    const sessionId = input.sessionId;
    // The refusals are ordered so the most specific one wins: a session that
    // is mid-turn cannot be compacted no matter what else is true, and a
    // session that already has a compaction running must not start a second.
    if (this.#port.isSessionBusy(sessionId)) {
      return {
        ok: false,
        status: 409,
        code: 'session_busy',
        message: 'The session has an unsettled run; compact after the turn settles.',
      };
    }
    if (this.#inFlight.has(sessionId)) {
      return {
        ok: false,
        status: 409,
        code: 'compact_in_flight',
        message: 'A compaction is already running for this session.',
      };
    }
    if (!this.#port.hasWorker(sessionId)) {
      // 613 Phase 0's Go/No-Go degradation: a cold worker cannot be relied on
      // to resolve the summarizer's provider configuration, so the Host does
      // not spawn one here. The user is asked to send a message first, which
      // brings a worker up.
      return {
        ok: false,
        status: 409,
        code: 'no_live_worker',
        message: 'No live worker for this session; send a message first, then compact.',
      };
    }
    this.#inFlight.add(sessionId);
    return { ok: true, events: this.#run(input) };
  }

  async *#run(input: SessionCompactInput): AsyncIterable<SessionCompactEvent> {
    const sessionId = input.sessionId;
    let lastMessageCount = 0;
    let settle: ((outcome: CompactOutcome) => void) | null = null;
    const outcome = new Promise<CompactOutcome>((resolve) => {
      settle = resolve;
    });
    // Subscribed BEFORE the command is sent: a worker that answers before the
    // sender returns would otherwise be heard by nobody.
    const unsubscribe = this.#port.onWorkerMessage((frameSessionId, message) => {
      if (frameSessionId !== sessionId) return;
      const type = message.type;
      if (type === 'compact:done') {
        settle?.({ kind: 'done', result: readCompactDone(message, lastMessageCount) });
        return;
      }
      if (type === 'compact:error') {
        const detail = typeof message.message === 'string' ? message.message : 'Compaction failed.';
        settle?.({ kind: 'failed', code: 'compaction_failed', message: detail });
        return;
      }
      if (type === 'chat:token_usage') {
        // The worker pushes a fresh context snapshot right before
        // `compact:done`; its message count is the only place the post-
        // compaction transcript size is reported.
        const breakdown = isRecord(message.debugBreakdown) ? message.debugBreakdown : null;
        const count = readFiniteNumber(breakdown?.msgs);
        if (count !== null) lastMessageCount = count;
      }
    });

    try {
      const sent = this.#port.sendCommand(sessionId, {
        type: 'compact',
        sessionId,
        ...(input.instructions === undefined ? {} : { customInstructions: input.instructions }),
      });
      if (!sent) {
        yield {
          event: 'compact:failed',
          data: {
            status: 'error',
            code: 'worker_unreachable',
            message: 'The compaction command could not be delivered to the worker.',
          },
        };
        return;
      }
      this.#logger.info('Compaction requested', { sessionId });
      yield { event: 'compact:started', data: { sessionId } };

      const deadline = Date.now() + this.#timeoutMs;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          yield {
            event: 'compact:failed',
            data: {
              status: 'error',
              code: 'compact_timeout',
              message: 'The compaction did not finish in time.',
            },
          };
          return;
        }
        const race = await Promise.race([
          outcome.then((value) => ({ kind: 'outcome' as const, value })),
          delay(Math.min(this.#keepaliveMs, remaining)).then(() => ({ kind: 'tick' as const })),
        ]);
        if (race.kind === 'outcome') {
          if (race.value.kind === 'done') {
            yield { event: 'compact:completed', data: race.value.result };
          } else {
            yield {
              event: 'compact:failed',
              data: { status: 'error', code: race.value.code, message: race.value.message },
            };
          }
          return;
        }
        // A worker that died mid-compaction will never answer; the keepalive
        // tick is where that is noticed, so the request does not hang until
        // the full timeout.
        if (!this.#port.hasWorker(sessionId)) {
          yield {
            event: 'compact:failed',
            data: {
              status: 'error',
              code: 'worker_unreachable',
              message: 'The worker exited before the compaction finished.',
            },
          };
          return;
        }
        yield { event: 'compact:keepalive', data: { at: Date.now() } };
      }
    } finally {
      unsubscribe();
      this.#inFlight.delete(sessionId);
    }
  }
}

/**
 * A side question: one answer, no transcript change, no run.
 *
 * The worker command and the answer frame already exist (`side:question` /
 * `side:answer`), so this class forwards them and correlates the reply by
 * its request id. It does NOT refuse on a busy session: asking while a turn
 * runs is the entire point of the feature.
 */
export class SessionSideQuestioner implements HostSessionSideQuestionApiV1 {
  readonly #port: SessionSideQuestionPort;
  readonly #timeoutMs: number;
  readonly #logger: SessionCompactionLogger;

  constructor(port: SessionSideQuestionPort, options: SessionSideQuestionerOptions = {}) {
    this.#port = port;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_SIDE_QUESTION_TIMEOUT_MS;
    this.#logger = options.logger ?? NOOP_LOGGER;
  }

  async ask(input: { sessionId: string; question: string }): Promise<{ answer: string }> {
    const sessionId = input.sessionId;
    if (!this.#port.hasWorker(sessionId)) {
      throw new HostSessionCompactionError(
        409,
        'no_live_worker',
        'No live worker for this session; send a message first, then ask.',
      );
    }
    const id = randomUUID();
    let settle: ((frame: Record<string, unknown>) => void) | null = null;
    const answer = new Promise<Record<string, unknown>>((resolve) => {
      settle = resolve;
    });
    const unsubscribe = this.#port.onWorkerMessage((frameSessionId, message) => {
      if (frameSessionId !== sessionId) return;
      if (message.type !== 'side:answer') return;
      if (message.id !== id) return;
      settle?.(message);
    });
    try {
      const sent = this.#port.sendCommand(sessionId, {
        type: 'side:question',
        sessionId,
        id,
        question: input.question,
      });
      if (!sent) {
        throw new HostSessionCompactionError(
          503,
          'worker_unreachable',
          'The side question could not be delivered to the worker.',
        );
      }
      this.#logger.info('Side question issued', { sessionId, id, charCount: input.question.length });
      const timeout = new Promise<'timeout'>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), this.#timeoutMs);
        timer.unref?.();
      });
      const frame = await Promise.race([answer, timeout]);
      if (frame === 'timeout') {
        throw new HostSessionCompactionError(
          504,
          'side_question_timeout',
          'The side question timed out.',
        );
      }
      if (typeof frame.error === 'string' && frame.error.length > 0) {
        throw new HostSessionCompactionError(500, 'side_question_failed', frame.error);
      }
      return { answer: typeof frame.answer === 'string' ? frame.answer : '' };
    } finally {
      unsubscribe();
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
