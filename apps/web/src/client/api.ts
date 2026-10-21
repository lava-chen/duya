/**
 * The browser's typed view of the same-origin BFF.
 *
 * ## What this file is allowed to know
 *
 * Routes, request bodies, and the shape of what comes back. It never sees the
 * Host bearer — that lives in the server process and stays there — and it never
 * guesses a response shape. Every route and wrapper below was read from
 * `src/server/web-bff.ts` on this branch.
 *
 * ## Why responses are narrowed instead of cast
 *
 * The Host records this surface could receive are wide: a session row carries a
 * workspace binding, a permission profile and an extension bag; a durable run
 * carries a manifest. None of that is drawn here, and casting a partial JSON
 * object into the full record type would put invented values — a fabricated
 * `permissionMode`, an empty `manifest` — into state a component might later
 * read as fact. So the transport narrows once into `SessionSummary` and
 * `DurableRunRecord`, which carry only fields that came off the wire, and
 * everything it cannot display is dropped at the boundary instead of being
 * passed along as a half-known object.
 */

import type { HostPermissionRequest, HostPermissionRequestStatus, Millis } from '@duya/agent-protocol';
import { isRecord } from './envelope.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type PermissionDecision = 'allow' | 'always' | 'deny';

export type DurableRunStatus = 'running' | 'completed' | 'cancelled' | 'budget_exhausted' | 'failed';

/** Everything the sidebar and header draw about one session. */
export interface SessionSummary {
  readonly id: string;
  readonly title: string;
  readonly projectName: string;
  /** Workspace-relative working directory, when the Host recorded one. */
  readonly workingDirectory: string;
  readonly model: string;
  readonly agentName: string;
  readonly mode: string;
  readonly updatedAt: number;
  readonly recencyAt: number;
  readonly timelineCount: number;
}

/** The durable run ledger facts this client is allowed to assert. */
export interface DurableRunRecord {
  readonly runId: string;
  readonly sessionId: string;
  readonly status: DurableRunStatus;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

export interface BootstrapResult {
  readonly apiVersion: number;
  readonly csrfToken: string;
}

export interface HandshakeSummary {
  readonly ok: boolean;
  readonly apiVersion: number;
  readonly protocol: string;
  readonly databaseReady: boolean;
}

export interface DurableMessageRow {
  readonly id: string;
  readonly createdAt: number;
  readonly turnId: string | null;
  readonly runId?: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly thinking: string;
}

export interface DurableCompactionRow {
  readonly id: string;
  readonly createdAt: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number | null;
}

export interface MessagePageResult {
  readonly messages: readonly DurableMessageRow[];
  readonly compactions: readonly DurableCompactionRow[];
  readonly nextCursor: string | null;
}

export type StartRunOutcome =
  | { readonly accepted: true; readonly stage: 'created' | 'dispatched'; readonly runId: string }
  | { readonly accepted: false; readonly stage: string; readonly reason: string };

export type CancelOutcome =
  | { readonly requested: true; readonly runId: string }
  | { readonly requested: false; readonly runId: string; readonly reason: string };

/** A failed BFF call, carrying the status and the server's own error code. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`${status} ${code}`);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  readonly fetchImpl?: FetchLike;
  /** Prefix for every route; empty for same-origin. */
  readonly baseUrl?: string;
}

interface RequestOptions {
  readonly signal?: AbortSignal;
}

/**
 * Same-origin client for the browser transport.
 *
 * Mutations carry the per-process CSRF token from `GET /api/bootstrap`. The
 * token is fetched once and reused; a rejection as `csrf_failed` refreshes it
 * and retries exactly once, because a token can be invalidated by a server
 * restart and retrying forever would turn that into a hang.
 */
export class ApiClient {
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;
  #csrf: string | null = null;

  constructor(options: ApiClientOptions = {}) {
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#baseUrl = options.baseUrl ?? '';
  }

  async bootstrap(options: RequestOptions = {}): Promise<BootstrapResult> {
    const body = await this.#readJson('/api/bootstrap', { ...options });
    const csrfToken = body['csrfToken'];
    const apiVersion = body['apiVersion'];
    if (typeof csrfToken !== 'string' || csrfToken === '' || typeof apiVersion !== 'number') {
      throw new ApiError(200, 'invalid_bootstrap');
    }
    this.#csrf = csrfToken;
    return { apiVersion, csrfToken };
  }

  async handshake(options: RequestOptions = {}): Promise<HandshakeSummary> {
    const body = await this.#readJson('/api/handshake', { ...options });
    const protocol = body['protocol'];
    if (!isRecord(protocol)) throw new ApiError(200, 'invalid_handshake');
    return {
      ok: body['ok'] === true,
      apiVersion: typeof body['apiVersion'] === 'number' ? body['apiVersion'] : 0,
      protocol: `${String(protocol['major'])}.${String(protocol['minor'])}`,
      databaseReady: body['databaseReady'] === true,
    };
  }

  async listSessions(options: RequestOptions & { readonly limit?: number } = {}): Promise<readonly SessionSummary[]> {
    const limit = options.limit ?? 100;
    const body = await this.#readJson(`/api/sessions?limit=${limit}`, { ...options });
    const sessions = body['sessions'];
    if (!Array.isArray(sessions)) throw new ApiError(200, 'invalid_session_page');
    const items: SessionSummary[] = [];
    for (const entry of sessions) {
      const summary = readSessionSummary(entry);
      if (summary !== null) items.push(summary);
    }
    return items;
  }

  async readMessages(
    sessionId: string,
    options: RequestOptions & { readonly limit?: number; readonly cursor?: string } = {},
  ): Promise<MessagePageResult> {
    const params = new URLSearchParams();
    params.set('limit', String(options.limit ?? 100));
    if (options.cursor !== undefined) params.set('cursor', options.cursor);
    const body = await this.#readJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages?${params.toString()}`,
      { ...options },
    );
    return readMessagePage(body);
  }

  async listRuns(
    sessionId: string,
    options: RequestOptions & { readonly limit?: number } = {},
  ): Promise<readonly DurableRunRecord[]> {
    const limit = options.limit ?? 50;
    const body = await this.#readJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/runs?limit=${limit}`,
      { ...options },
    );
    const runs = body['runs'];
    if (!Array.isArray(runs)) throw new ApiError(200, 'invalid_run_page');
    const records: DurableRunRecord[] = [];
    for (const entry of runs) {
      const record = readRunRecord(entry);
      if (record !== null) records.push(record);
    }
    return records;
  }

  /**
   * The pending worker permission ledger — the source of truth for approvals.
   *
   * Deliberately NOT the tool-approval ledger. Those rows record a decision
   * that was already made and can never be answered here; conflating the two
   * would put buttons on rows that cannot be acted on.
   */
  async listPendingApprovals(sessionId: string, options: RequestOptions = {}): Promise<readonly HostPermissionRequest[]> {
    const body = await this.#readJson(`/api/sessions/${encodeURIComponent(sessionId)}/approvals`, { ...options });
    const approvals = body['approvals'];
    if (!Array.isArray(approvals)) throw new ApiError(200, 'invalid_approval_page');
    const requests: HostPermissionRequest[] = [];
    for (const entry of approvals) {
      const request = readPermissionRequest(entry);
      if (request !== null) requests.push(request);
    }
    return requests;
  }

  async startRun(sessionId: string, prompt: string, options: RequestOptions = {}): Promise<StartRunOutcome> {
    const body = await this.#mutate('/api/runs/start', { sessionId, prompt }, options);
    if (body['accepted'] === true && typeof body['runId'] === 'string') {
      return {
        accepted: true,
        stage: body['stage'] === 'created' ? 'created' : 'dispatched',
        runId: body['runId'],
      };
    }
    return {
      accepted: false,
      stage: typeof body['stage'] === 'string' ? body['stage'] : 'refused_dispatch_failed',
      reason: typeof body['reason'] === 'string' ? body['reason'] : 'unknown',
    };
  }

  async cancelRun(runId: string, reason: string | undefined, options: RequestOptions = {}): Promise<CancelOutcome> {
    const body = await this.#mutate(
      `/api/runs/${encodeURIComponent(runId)}/cancel`,
      reason === undefined ? {} : { reason },
      options,
    );
    if (body['requested'] === true && typeof body['runId'] === 'string') {
      return { requested: true, runId: body['runId'] };
    }
    return {
      requested: false,
      runId: typeof body['runId'] === 'string' ? body['runId'] : runId,
      reason: typeof body['reason'] === 'string' ? body['reason'] : 'unknown',
    };
  }

  async resolveApproval(
    requestId: string,
    decision: PermissionDecision,
    options: RequestOptions = {},
  ): Promise<HostPermissionRequest> {
    const body = await this.#mutate(
      `/api/approvals/${encodeURIComponent(requestId)}/resolve`,
      { decision },
      options,
    );
    const result = readPermissionRequest(body['result']);
    if (result === null) throw new ApiError(200, 'invalid_approval_result');
    return result;
  }

  /** The event stream URL for one run, exposed so the stream can be driven directly by tests. */
  eventStreamUrl(runId: string, afterSeq: number): string {
    return `${this.#baseUrl}/api/runs/${encodeURIComponent(runId)}/events?afterSeq=${afterSeq}`;
  }

  async #readJson(path: string, options: RequestOptions): Promise<Record<string, unknown>> {
    const response = await this.#fetch(this.#baseUrl + path, {
      method: 'GET',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return parseJsonResponse(response);
  }

  async #mutate(path: string, payload: unknown, options: RequestOptions): Promise<Record<string, unknown>> {
    const attempt = async (csrf: string): Promise<Response> => await this.#fetch(this.#baseUrl + path, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-duya-csrf': csrf,
      },
      body: JSON.stringify(payload),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const first = this.#csrf ?? (await this.#readBootstrapToken(options));
    const response = await attempt(first);
    // One retry, never a loop. A stale token after a server restart is the case
    // this covers; a client that retries forever hides a server that is down.
    if (response.status === 403) {
      const failure = await readErrorCode(response);
      if (failure !== 'csrf_failed') throw new ApiError(response.status, failure);
      this.#csrf = null;
      const refreshed = await this.#readBootstrapToken(options);
      return parseJsonResponse(await attempt(refreshed));
    }
    return parseJsonResponse(response);
  }

  async #readBootstrapToken(options: RequestOptions): Promise<string> {
    const result = await this.bootstrap(options);
    return result.csrfToken;
  }
}

async function parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new ApiError(response.status, await readErrorCode(response));
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new ApiError(response.status, 'invalid_json');
  }
  if (!isRecord(parsed)) throw new ApiError(response.status, 'invalid_json');
  return parsed;
}

async function readErrorCode(response: Response): Promise<string> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return 'upstream_unavailable';
  }
  if (isRecord(parsed) && isRecord(parsed['error'])) {
    const code = parsed['error']['code'];
    if (typeof code === 'string' && /^[a-z0-9_]{1,80}$/.test(code)) return code;
  }
  return 'upstream_unavailable';
}

function readString(value: Record<string, unknown>, key: string, fallback = ''): string {
  const field = value[key];
  return typeof field === 'string' ? field : fallback;
}

function readMillis(value: Record<string, unknown>, key: string): Millis {
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) ? (field as Millis) : 0;
}

function readOptionalMillis(value: Record<string, unknown>, key: string): Millis | null {
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) ? (field as Millis) : null;
}

function readCount(value: Record<string, unknown>, key: string): number {
  const count = value[key];
  return typeof count === 'number' && Number.isFinite(count) ? count : 0;
}

/**
 * Narrow one session list entry into what the sidebar draws.
 *
 * `workingDirectory` is the workspace-RELATIVE path the Host recorded. A raw
 * workspace id would be an implementation label with no meaning to the person
 * reading the sidebar, and the absolute root is a local path this transport has
 * no business displaying.
 */
export function readSessionSummary(value: unknown): SessionSummary | null {
  if (!isRecord(value)) return null;
  const session = value['session'];
  if (!isRecord(session)) return null;
  const id = session['id'];
  if (typeof id !== 'string' || id === '') return null;

  const workspace = isRecord(session['workspace']) ? session['workspace'] : null;
  const relativePath = workspace !== null && workspace['state'] === 'bound' && typeof workspace['relativePath'] === 'string'
    ? workspace['relativePath']
    : '';

  const recencyAt = readOptionalMillis(session, 'recencyAt');
  const updatedAt = readMillis(session, 'updatedAt');
  return {
    id,
    title: readString(session, 'title'),
    projectName: readString(session, 'projectName'),
    workingDirectory: relativePath,
    model: readString(session, 'model'),
    agentName: readString(session, 'agentName'),
    mode: readString(session, 'mode'),
    updatedAt,
    recencyAt: recencyAt ?? updatedAt,
    timelineCount: readCount(value, 'timelineCount'),
  };
}

export function readRunRecord(value: unknown): DurableRunRecord | null {
  if (!isRecord(value)) return null;
  const runId = value['runId'];
  const sessionId = value['sessionId'];
  if (typeof runId !== 'string' || runId === '') return null;
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  return {
    runId,
    sessionId,
    status: readRunStatus(value['status']),
    createdAt: readMillis(value, 'createdAt'),
    startedAt: readOptionalMillis(value, 'startedAt'),
    finishedAt: readOptionalMillis(value, 'finishedAt'),
  };
}

const RUN_STATUSES: readonly DurableRunStatus[] = [
  'running',
  'completed',
  'cancelled',
  'budget_exhausted',
  'failed',
];

function readRunStatus(value: unknown): DurableRunStatus {
  return typeof value === 'string' && (RUN_STATUSES as readonly string[]).includes(value)
    ? (value as DurableRunStatus)
    : 'running';
}

/** A durable run status is terminal once it can no longer change. */
export function isTerminalRunStatus(status: DurableRunStatus): boolean {
  return status !== 'running';
}

export function readPermissionRequest(value: unknown): HostPermissionRequest | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  if (typeof id !== 'string' || id === '') return null;
  const toolInput = value['toolInput'];
  const sessionId = value['sessionId'];
  return {
    id,
    sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : null,
    toolName: readString(value, 'toolName'),
    toolInput: isRecord(toolInput) ? (toolInput as Readonly<Record<string, unknown>>) : null,
    status: readPermissionStatus(value['status']),
    decision: typeof value['decision'] === 'string' ? value['decision'] : null,
    message: typeof value['message'] === 'string' ? value['message'] : null,
    updatedPermissions: null,
    updatedInput: null,
    createdAt: readMillis(value, 'createdAt'),
    resolvedAt: readOptionalMillis(value, 'resolvedAt'),
  };
}

const PERMISSION_STATUSES: readonly HostPermissionRequestStatus[] = [
  'pending',
  'allow',
  'deny',
  'timeout',
  'aborted',
];

function readPermissionStatus(value: unknown): HostPermissionRequestStatus {
  return typeof value === 'string' && (PERMISSION_STATUSES as readonly string[]).includes(value)
    ? (value as HostPermissionRequestStatus)
    : 'pending';
}

function readMessagePage(body: Record<string, unknown>): MessagePageResult {
  const raw = body['messages'];
  if (!Array.isArray(raw)) throw new ApiError(200, 'invalid_message_page');
  const messages: DurableMessageRow[] = [];
  const compactions: DurableCompactionRow[] = [];
  for (const entry of raw) {
    const row = readMessageItem(entry);
    if (row.kind === 'message') messages.push(row.row);
    else if (row.kind === 'compaction') compactions.push(row.row);
  }
  const nextCursor = body['nextCursor'];
  return {
    messages,
    compactions,
    nextCursor: typeof nextCursor === 'string' && nextCursor !== '' ? nextCursor : null,
  };
}

/**
 * Split one durable timeline item into the two things this surface draws.
 *
 * A page also carries control entries (`model_change`, `mode_change`, branches)
 * and worker rollout events. Those are real records, but they are not
 * conversation, so they are dropped here rather than rendered as blank rows.
 */
function readMessageItem(value: unknown):
  | { readonly kind: 'message'; readonly row: DurableMessageRow }
  | { readonly kind: 'compaction'; readonly row: DurableCompactionRow }
  | { readonly kind: 'skipped' } {
  if (!isRecord(value)) return { kind: 'skipped' };
  const entry = value['entry'];
  if (!isRecord(entry)) return { kind: 'skipped' };

  const rawId = value['id'];
  const id = typeof rawId === 'string' && rawId !== '' ? rawId : null;
  const createdAt = readMillis(value, 'createdAt');

  if (entry['type'] === 'compaction') {
    const tokensBefore = entry['tokensBefore'];
    const tokensAfter = entry['tokensAfter'];
    return {
      kind: 'compaction',
      row: {
        id: id ?? `compaction-${createdAt}`,
        createdAt,
        tokensBefore: typeof tokensBefore === 'number' ? tokensBefore : 0,
        tokensAfter: typeof tokensAfter === 'number' ? tokensAfter : null,
      },
    };
  }
  if (entry['type'] !== 'message') return { kind: 'skipped' };

  const message = entry['message'];
  if (!isRecord(message)) return { kind: 'skipped' };
  const role = message['role'];
  if (role !== 'user' && role !== 'assistant') return { kind: 'skipped' };
  // A message the engine marked hidden is context, not conversation.
  if (message['visibility'] === 'hidden') return { kind: 'skipped' };

  const content = message['content'];
  let text = '';
  let thinking = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    const thoughts: string[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block['type'] === 'text' && typeof block['text'] === 'string') parts.push(block['text']);
      if (block['type'] === 'thinking' && typeof block['thinking'] === 'string') thoughts.push(block['thinking']);
    }
    text = parts.join('');
    thinking = thoughts.join('');
  }
  if (text.trim() === '' && thinking.trim() === '') return { kind: 'skipped' };

  const turnId = value['turnId'];
  const runId = entry['runId'];
  return {
    kind: 'message',
    row: {
      id: id ?? `message-${createdAt}`,
      createdAt,
      turnId: typeof turnId === 'string' && turnId !== '' ? turnId : null,
      ...(typeof runId === 'string' && runId !== '' ? { runId } : {}),
      role,
      text,
      thinking,
    },
  };
}
