/**
 * types.ts — the Host-side seams of the Project channel domain.
 *
 * This slice (plan C) owns the domain rules between a platform event and the
 * Session/Run machinery that already exists: which messages are accepted, how
 * a busy Coordinator waits without losing the message, who may send, and what
 * survives a crash. It owns NO second Run launcher and NO second transcript:
 * bodies live in the inbound ledger, receipts live in `session_inputs`, and
 * starting a turn goes through the Host's existing admission port.
 *
 * Every dependency is a port so this module stays importable without the
 * Gateway, Electron, or the composition root (plan §5: C consumes the neutral
 * transport, never `@duya/gateway`).
 */

import { randomUUID } from 'node:crypto';
import type {
  ProjectChannelErrorCode,
  ProjectChannelTransportPort,
} from '@duya/agent-protocol/project-channels';
import { isProjectChannelErrorCode } from '@duya/agent-protocol/project-channels';
import type { ProjectChannelStore } from '@duya/data';
import type { ProjectStore } from '@duya/data/project-store';
import type { SessionControlLeaseStore, SessionInputStore } from '@duya/data';
import type { SessionStore } from '@duya/data/session-store';
import type { ProjectChannelSecretPort } from './secrets.js';

/** The stores this domain reads and writes. All of them already exist in core. */
export interface ProjectChannelHostStores {
  readonly channels: ProjectChannelStore;
  readonly projects: Pick<ProjectStore, 'get' | 'list'>;
  readonly sessions: Pick<SessionStore, 'get'>;
  readonly sessionInputs: Pick<
    SessionInputStore,
    'accept' | 'claimPending' | 'advanceStage' | 'get' | 'listForSession'
  >;
  readonly leases: Pick<SessionControlLeaseStore, 'read'>;
}

/**
 * What the Host's execution layer can do for one accepted channel message.
 *
 * The port deliberately takes only the facts the domain derived: a session, a
 * framed prompt, and the inbound it came from. The actor is NOT a parameter —
 * a caller that could name an actor would be able to post as a local user,
 * which is exactly what the plan forbids.
 */
export interface ProjectChannelExecutionPort {
  isSessionBusy(sessionId: string): boolean;
  /**
   * Whether `(sessionId, runId, epoch)` is the Host's CURRENT live attempt.
   *
   * This is the fence the domain cannot compute on its own and must not fake:
   * a run that settled, an epoch superseded by a retry, or a Coordinator that
   * was replaced all keep their old ids, so a send authorized against the id
   * alone would still succeed. The Host answers from its run records — the same
   * source the plugin-app and checkout paths already use.
   */
  isCurrentAttempt(sessionId: string, runId: string, epoch: number): boolean | Promise<boolean>;
  startRun(input: {
    readonly sessionId: string;
    readonly prompt: string;
    readonly source: 'project_channel';
    readonly inboundId: string;
    readonly bindingId: string;
    readonly projectId: string;
  }): Promise<
    | { readonly accepted: true; readonly runId: string }
    | { readonly accepted: false; readonly stage: string; readonly reason?: string }
  >;
}

/** Structured logger; the Host passes its existing run-execution logger. */
export interface ProjectChannelLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, error?: Error, fields?: Record<string, unknown>): void;
}

/**
 * A refusal with a stable domain code. The code set is the frozen protocol set
 * — this class adds nothing to it, so callers map a channel refusal without
 * guessing from a message string.
 */
export class ProjectChannelServiceError extends Error {
  readonly code: ProjectChannelErrorCode;

  constructor(code: ProjectChannelErrorCode, message: string) {
    super(message);
    this.name = 'ProjectChannelServiceError';
    this.code = code;
  }
}

export function projectChannelServiceError(
  code: ProjectChannelErrorCode,
  message: string,
): ProjectChannelServiceError {
  return new ProjectChannelServiceError(code, message);
}

/**
 * Read the domain code out of a transport/secret failure without importing
 * the module that produced it. The Gateway's failure class carries `code`;
 * anything else is an availability problem, not a crafted refusal.
 */
export function errorCodeOf(error: unknown, fallback: ProjectChannelErrorCode): ProjectChannelErrorCode {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && isProjectChannelErrorCode(code)) return code;
  }
  return fallback;
}

/** Options every collaborator receives; `now`/`newId` are injectable for tests. */
export interface ProjectChannelClock {
  readonly now: () => number;
  readonly newId: () => string;
  readonly sleep: (ms: number) => Promise<void>;
}

/** The resolved collaborators the inbound/outbound halves both read. */
export interface ProjectChannelContext {
  readonly stores: ProjectChannelHostStores;
  readonly transport: ProjectChannelTransportPort;
  readonly secrets: ProjectChannelSecretPort;
  readonly execution: ProjectChannelExecutionPort;
  /** The project domain's existing Coordinator ensure; never a new session kind. */
  readonly ensureCoordinator: (projectId: string) => Promise<{ readonly sessionId: string }>;
  /** The composition's own shutdown flag; a draining queue must not start a run after close. */
  readonly isClosed?: () => boolean;
  readonly logger: ProjectChannelLogger;
  readonly clock: ProjectChannelClock;
  /** Platform message length ceiling; longer text is refused, never truncated. */
  readonly maxTextLength: number;
}

export const DEFAULT_CLOCK: ProjectChannelClock = {
  now: () => Date.now(),
  newId: () => randomUUID(),
  sleep: (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
};
