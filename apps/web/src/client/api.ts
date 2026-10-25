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

import type {
  CancelAgentRunResult,
  DurableTimelineEntry,
  HostCheckoutObserved,
  HostCheckoutRetainReason,
  HostIntegrationRecord,
  HostIntegrationState,
  HostIntegrationSyncFailure,
  HostIntegrationSyncResult,
  HostIntegrationSyncStatus,
  HostIntegrationSyncWritten,
  HostMessagePage,
  HostMessageReadQuery,
  HostPermissionRequest,
  HostPermissionRequestStatus,
  HostProviderCatalog,
  HostSessionCheckoutView,
  HostSessionCreateInput,
  HostSessionDeleteResult,
  HostSessionListQuery,
  HostSessionPage,
  HostSessionPatch,
  HostSessionRecord,
  HostSessionUpdateResult,
  HostWorkspaceBinding,
  Millis,
  RunId,
  SessionId,
  StartAgentRunResult,
} from '@duya/agent-protocol';
import { isRecord } from './envelope.js';
import type { UiStartRunInput } from '@/services/ui-services';

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

  async listHostSessions(query: HostSessionListQuery = {}): Promise<HostSessionPage> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    if (query.includeArchived !== undefined) params.set('includeArchived', String(query.includeArchived));
    if (query.parentSessionId !== undefined || query.includeAllSessions !== undefined || query.includeDeleted !== undefined ||
        query.workspaceId !== undefined || query.workspaceRootId !== undefined || query.workspaceRelativePath !== undefined ||
        query.offset !== undefined) {
      throw new ApiError(400, 'unsupported_session_filter');
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    const body = await this.#readJson(`/api/sessions${suffix}`, {});
    if (!Array.isArray(body['sessions'])) throw new ApiError(200, 'invalid_session_page');
    const sessions: HostSessionPage['sessions'][number][] = [];
    for (const value of body['sessions']) {
      const item = readHostSessionListItem(value);
      if (item !== null) sessions.push(item);
    }
    return { sessions, nextCursor: readNullableString(body['nextCursor']) };
  }

  async getHostSession(sessionId: SessionId): Promise<HostSessionRecord | null> {
    const body = await this.#readJson(`/api/sessions/${encodeURIComponent(sessionId)}`, {});
    if (body['session'] === undefined) return null;
    const session = readHostSessionRecord(body['session']);
    if (session === null) throw new ApiError(200, 'invalid_session');
    return session;
  }

  async createHostSession(input: HostSessionCreateInput): Promise<HostSessionRecord> {
    const body = await this.#mutate('/api/sessions', input, {}, 'POST');
    const session = readHostSessionRecord(body['session']);
    if (session === null) throw new ApiError(201, 'invalid_session');
    return session;
  }

  async updateHostSession(
    sessionId: SessionId,
    expectedUpdatedAt: number | undefined,
    patch: HostSessionPatch,
  ): Promise<HostSessionUpdateResult> {
    const body = await this.#mutate(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
      patch,
    }, {}, 'PATCH');
    if (body['updated'] === false && (body['reason'] === 'not_found' || body['reason'] === 'conflict')) {
      return { updated: false, reason: body['reason'] };
    }
    const session = readHostSessionRecord(body['session']);
    if (body['updated'] !== true || session === null) throw new ApiError(200, 'invalid_session_update');
    return { updated: true, session };
  }

  async deleteHostSession(sessionId: SessionId, expectedUpdatedAt: number): Promise<HostSessionDeleteResult> {
    const query = new URLSearchParams({ expectedUpdatedAt: String(expectedUpdatedAt) });
    const body = await this.#mutate(`/api/sessions/${encodeURIComponent(sessionId)}?${query.toString()}`, {}, {}, 'DELETE');
    if (body['deleted'] === true) return { deleted: true };
    if (body['deleted'] === false && (body['reason'] === 'not_found' || body['reason'] === 'conflict')) {
      return { deleted: false, reason: body['reason'] };
    }
    throw new ApiError(200, 'invalid_session_delete');
  }

  async readHostMessages(sessionId: SessionId, query: HostMessageReadQuery = {}): Promise<HostMessagePage> {
    // The source projection is a Host-side filter this transport cannot
    // express. Dropping it would answer a narrower question with a wider page,
    // so it is refused instead.
    if (query.sources !== undefined) throw new ApiError(400, 'unsupported_message_filter');
    const params = new URLSearchParams();
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.includeSuperseded !== undefined) params.set('includeSuperseded', String(query.includeSuperseded));
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    const body = await this.#readJson(`/api/sessions/${encodeURIComponent(sessionId)}/messages${suffix}`, {});
    if (!Array.isArray(body['messages'])) throw new ApiError(200, 'invalid_message_page');
    const messages: HostMessagePage['messages'][number][] = [];
    for (const value of body['messages']) {
      const item = readHostMessageItem(value);
      if (item !== null) messages.push(item);
    }
    return { sessionId, messages, nextCursor: readNullableString(body['nextCursor']) };
  }

  async listHostRuns(sessionId: SessionId, limit = 50, options: RequestOptions = {}): Promise<readonly {
    runId: RunId; sessionId: SessionId; status: DurableRunStatus;
    createdAt: number; startedAt: number | null; finishedAt: number | null;
  }[]> {
    const body = await this.#readJson(`/api/sessions/${encodeURIComponent(sessionId)}/runs?limit=${limit}`, { ...options });
    if (!Array.isArray(body['runs'])) throw new ApiError(200, 'invalid_run_page');
    const result = [];
    for (const value of body['runs']) {
      const run = readRunRecord(value);
      if (run !== null) result.push(run);
    }
    return result;
  }

  /**
   * Start one run.
   *
   * The shared renderer sends the turn's configuration: the model, the
   * provider, the thinking-effort level, the permission mode, the agent
   * profile, and the modes and tools the turn declares. This transport carries
   * all of them, because the Host resolves each of them the same way it does
   * for the Desktop renderer — a browser that could not name them would be a
   * browser whose turns silently ran under different rules than the user's.
   *
   * Anything else — a working directory, a raw options bag — is refused rather
   * than dropped, because a dropped option is a run that silently ran with
   * different configuration than the screen promised.
   */
  async startHostRun(input: UiStartRunInput): Promise<StartAgentRunResult> {
    const allowedKeys = new Set([
      'sessionId', 'prompt', 'origin', 'model', 'providerId', 'effort',
      'permissionMode', 'agentProfileId', 'modes', 'tools',
    ]);
    if (Object.keys(input).some((key) => !allowedKeys.has(key)) || typeof input.prompt !== 'string' ||
        (input.origin !== undefined && input.origin !== 'user')) {
      throw new ApiError(400, 'unsupported_run_options');
    }
    const body = await this.#mutate('/api/runs/start', {
      sessionId: input.sessionId,
      prompt: input.prompt,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.agentProfileId === undefined ? {} : { agentProfileId: input.agentProfileId }),
      ...(input.modes === undefined ? {} : { modes: input.modes }),
      ...(input.tools === undefined ? {} : { tools: input.tools }),
    }, {}, 'POST');
    if (body['accepted'] === true && typeof body['runId'] === 'string') {
      return { accepted: true, stage: body['stage'] === 'created' ? 'created' : 'dispatched', runId: body['runId'] };
    }
    const stage = body['stage'];
    if (stage !== 'refused_no_session' && stage !== 'refused_run_open_failed' && stage !== 'refused_dispatch_failed') {
      throw new ApiError(200, 'invalid_run_start_result');
    }
    return { accepted: false, stage, reason: typeof body['reason'] === 'string' ? body['reason'] : 'unknown' };
  }

  /**
   * Ask the Host to register a local directory as a workspace.
   *
   * The browser names a DIRECTORY, and the Host returns the workspace BINDING
   * that a session needs. The browser never gets to name the path the worker
   * runs in — it asks for a directory to be registered, and the Host decides
   * what that becomes. That is the same boundary the Desktop's workspace
   * registration keeps.
   */
  async registerLocalDirectory(directory: string): Promise<HostWorkspaceBinding> {
    const body = await this.#mutate(
      '/api/workspaces/local-directories',
      { directory },
      {},
      'POST',
    );
    const workspace = body['workspace'];
    if (!isRecord(workspace)) throw new ApiError(200, 'invalid_workspace_binding');
    return workspace as unknown as HostWorkspaceBinding;
  }

  /**
   * The Host's configured provider/model roster.
   *
   * This is the roster the Host adjudicates a turn's model against, so the
   * browser shows THIS one: offering a model the Host would refuse would be
   * offering a lie. The catalog carries no secrets -- it says whether a
   * provider HAS a key, never the key itself.
   *
   * `null` means the Host has no roster at all, which is a thing a screen can
   * show rather than an error.
   */
  async getProviderCatalog(): Promise<HostProviderCatalog | null> {
    const body = await this.#readJson('/api/providers/catalog', {});
    const catalog = body['catalog'];
    if (catalog === null || catalog === undefined) return null;
    if (!isRecord(catalog)) throw new ApiError(200, 'invalid_provider_catalog');
    return catalog as unknown as HostProviderCatalog;
  }

  async cancelHostRun(runId: RunId, reason?: string): Promise<CancelAgentRunResult> {
    const body = await this.#mutate(`/api/runs/${encodeURIComponent(runId)}/cancel`, reason === undefined ? {} : { reason }, {}, 'POST');
    if (body['requested'] === true && body['runId'] === runId) return { requested: true, runId };
    if (body['requested'] === false && body['runId'] === runId && typeof body['reason'] === 'string') {
      return { requested: false, runId, reason: body['reason'] };
    }
    throw new ApiError(200, 'invalid_run_cancel_result');
  }

  /**
   * The checkout the given session sits in, and whether it owns it.
   *
   * This is a READ of the Host's authority. It never decides whether the
   * session may write there, and it never decides whether the checkout may be
   * removed — the Host re-evaluates those at the moment of the action.
   */
  async observeCheckoutForSession(sessionId: SessionId): Promise<HostSessionCheckoutView> {
    const query = new URLSearchParams({ sessionId });
    const body = await this.#readJson(`/api/checkouts?${query.toString()}`, {});
    const checkout = readSessionCheckoutView(body['checkout']);
    if (checkout === null) throw new ApiError(200, 'invalid_checkout_view');
    return checkout;
  }

  async controlSessionCheckout(sessionId: string, command: import('@duya/agent-protocol').SessionCheckoutCommand): Promise<import('@duya/agent-protocol').SessionCheckoutResult> {
    const body = await this.#mutate('/api/checkouts/control', { sessionId, command }, {}, 'POST');
    const result = body.result;
    if (!isRecord(result) || !isRecord(result.state) || result.state.version !== 1 || typeof result.state.cwd !== 'string' || typeof result.outcome !== 'string') {
      throw new ApiError(200, 'invalid_checkout_control');
    }
    return result as unknown as import('@duya/agent-protocol').SessionCheckoutResult;
  }

  /** One checkout, observed by its root path. */
  async observeCheckoutByRoot(root: string): Promise<HostCheckoutObserved> {
    const query = new URLSearchParams({ root });
    const body = await this.#readJson(`/api/checkouts?${query.toString()}`, {});
    const checkout = readCheckoutObserved(body['checkout']);
    if (checkout === null) throw new ApiError(200, 'invalid_checkout');
    return checkout;
  }

  /**
   * Ask the Host to remove one checkout.
   *
   * A refusal is a NORMAL result and resolves: `{ removed: false, reason }`
   * is the Host's answer to "may this be deleted", and nothing was deleted.
   * Only a transport or I/O failure rejects — the caller renders the reason
   * instead of retrying, because retrying cannot change a dirty tree.
   */
  async requestCheckoutReclaim(root: string): Promise<
    { readonly removed: true } | { readonly removed: false; readonly reason: HostCheckoutRetainReason }
  > {
    const body = await this.#mutate('/api/checkouts/reclaim', { root }, {}, 'POST');
    const result = body['result'];
    if (!isRecord(result)) throw new ApiError(200, 'invalid_checkout_reclaim');
    if (result['removed'] === true) return { removed: true };
    const reason = result['reason'];
    if (result['removed'] === false && isCheckoutRetainReason(reason)) {
      return { removed: false, reason };
    }
    throw new ApiError(200, 'invalid_checkout_reclaim');
  }

  /**
   * Every pull request associated with a session, as last observed.
   *
   * This reads the Host's projection and never touches the network; the
   * explicit refresh below is the only call that does.
   */
  async observeIntegrationsForSession(sessionId: SessionId): Promise<readonly HostIntegrationRecord[]> {
    const query = new URLSearchParams({ sessionId });
    const body = await this.#readJson(`/api/integrations?${query.toString()}`, {});
    const records = body['records'];
    if (!Array.isArray(records)) throw new ApiError(200, 'invalid_integration_records');
    const result: HostIntegrationRecord[] = [];
    for (const entry of records) {
      const record = readIntegrationRecord(entry);
      // A record this transport cannot read is not dropped: a dropped pull
      // request is a pull request the user never learns about, and naming an
      // unreadable state `open` would be a fabrication.
      if (record === null) throw new ApiError(200, 'invalid_integration_record');
      result.push(record);
    }
    return result;
  }

  /**
   * Ask the Host to re-read the session's pull requests NOW.
   *
   * The result is reported as it happened: `status` is what the pass was, and
   * a partial pass is a partial pass, not a success.
   */
  async refreshIntegrationsForSession(sessionId: SessionId): Promise<HostIntegrationSyncResult> {
    const body = await this.#mutate('/api/integrations/sync', { sessionId }, {}, 'POST');
    const result = readIntegrationSyncResult(body['result']);
    if (result === null) throw new ApiError(200, 'invalid_integration_sync');
    return result;
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

  async #mutate(path: string, payload: unknown, options: RequestOptions, method: 'POST' | 'PATCH' | 'DELETE' = 'POST'): Promise<Record<string, unknown>> {
    const attempt = async (csrf: string): Promise<Response> => await this.#fetch(this.#baseUrl + path, {
      method,
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

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function readHostSessionRecord(value: unknown): HostSessionRecord | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  const workspace = value['workspace'];
  const permissionMode = value['permissionMode'];
  const extensions = value['extensions'];
  if (typeof id !== 'string' || id === '' || !isRecord(workspace) || !isRecord(extensions) ||
      (permissionMode !== 'default' && permissionMode !== 'auto' && permissionMode !== 'full_access')) return null;
  let hostWorkspace: HostWorkspaceBinding;
  if (workspace['state'] === 'legacy_unbound') {
    hostWorkspace = { state: 'legacy_unbound' };
  } else if (workspace['state'] === 'bound' && typeof workspace['workspaceId'] === 'string' &&
      (workspace['rootId'] === null || typeof workspace['rootId'] === 'string') &&
      typeof workspace['relativePath'] === 'string') {
    hostWorkspace = {
      state: 'bound',
      workspaceId: workspace['workspaceId'] as HostWorkspaceBinding extends { state: 'bound'; workspaceId: infer W } ? W : never,
      rootId: workspace['rootId'],
      relativePath: workspace['relativePath'],
    };
  } else return null;
  const requiredStrings = ['title', 'projectName', 'status', 'model', 'providerId', 'mode', 'agentType', 'agentName'] as const;
  if (requiredStrings.some((key) => typeof value[key] !== 'string')) return null;
  const agentProfileId = value['agentProfileId'];
  const parentSessionId = value['parentSessionId'];
  const draft = value['draft'];
  if (!(agentProfileId === null || typeof agentProfileId === 'string') ||
      !(parentSessionId === null || typeof parentSessionId === 'string') ||
      !(draft === null || typeof draft === 'string')) return null;
  const createdAt = value['createdAt'];
  const updatedAt = value['updatedAt'];
  const recencyAt = value['recencyAt'];
  const lastTurnStartedAt = value['lastTurnStartedAt'];
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) ||
      typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) ||
      !(recencyAt === null || (typeof recencyAt === 'number' && Number.isFinite(recencyAt))) ||
      !(lastTurnStartedAt === null || (typeof lastTurnStartedAt === 'number' && Number.isFinite(lastTurnStartedAt)))) return null;
  return {
    id: id as SessionId,
    workspace: hostWorkspace,
    title: value['title'] as string,
    projectName: value['projectName'] as string,
    status: value['status'] as string,
    model: value['model'] as string,
    providerId: value['providerId'] as HostSessionRecord['providerId'],
    mode: value['mode'] as string,
    permissionMode,
    agentProfileId: agentProfileId as HostSessionRecord['agentProfileId'],
    parentSessionId: parentSessionId as SessionId | null,
    agentType: value['agentType'] as string,
    agentName: value['agentName'] as string,
    draft,
    extensions: extensions as HostSessionRecord['extensions'],
    createdAt: createdAt as Millis,
    updatedAt: updatedAt as Millis,
    recencyAt: recencyAt as Millis | null,
    lastTurnStartedAt: lastTurnStartedAt as Millis | null,
  };
}

function readHostSessionListItem(value: unknown): HostSessionPage['sessions'][number] | null {
  if (!isRecord(value)) return null;
  const session = readHostSessionRecord(value['session']);
  const timelineCount = value['timelineCount'];
  if (session === null || typeof timelineCount !== 'number' || !Number.isSafeInteger(timelineCount) || timelineCount < 0) return null;
  return { session, timelineCount };
}

function readHostMessageItem(value: unknown): HostMessagePage['messages'][number] | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  const sequence = value['sequence'];
  const createdAt = value['createdAt'];
  const turnId = value['turnId'];
  const entry = value['entry'];
  if (typeof id !== 'string' || id === '' || typeof sequence !== 'number' || !Number.isSafeInteger(sequence) ||
      typeof createdAt !== 'number' || !Number.isFinite(createdAt) ||
      !(turnId === null || typeof turnId === 'string') || !isRecord(entry)) return null;
  if (entry['type'] === 'message') {
    const nested = entry['message'];
    if (typeof entry['id'] !== 'string' || typeof entry['createdAt'] !== 'number' || !isRecord(nested) ||
        typeof nested['role'] !== 'string' ||
        !(typeof nested['content'] === 'string' || Array.isArray(nested['content']))) return null;
  } else if (entry['type'] === 'compaction') {
    if (typeof entry['id'] !== 'string' || typeof entry['createdAt'] !== 'number' ||
        typeof entry['summary'] !== 'string' || typeof entry['firstKeptMessageId'] !== 'string' ||
        !Array.isArray(entry['compactedMessageIds']) || typeof entry['tokensBefore'] !== 'number' ||
        typeof entry['strategy'] !== 'string') return null;
  } else return null;
  return {
    id,
    sequence,
    createdAt: createdAt as Millis,
    turnId,
    entry: entry as unknown as DurableTimelineEntry,
  };
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
  const mode = readString(value, 'mode');
  const reason = readString(value, 'reason');
  return {
    id,
    sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : null,
    toolName: readString(value, 'toolName'),
    toolInput: isRecord(toolInput) ? (toolInput as Readonly<Record<string, unknown>>) : null,
    // The producer's own words. A Host that predates these columns sends
    // none, and an absent fact is null — not a guess.
    mode: mode === '' ? null : mode,
    expiresAt: readOptionalMillis(value, 'expiresAt'),
    reason: reason === '' ? null : reason,
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

/**
 * The checkout observation, read without inventing a field.
 *
 * Every value here is a point-in-time read of the Host's authority, so a
 * field this transport cannot read makes the whole observation unreadable —
 * a half-known observation is how "reclaimable: true" turns into a decision
 * nobody took.
 */
function readCheckoutObserved(value: unknown): HostCheckoutObserved | null {
  if (!isRecord(value)) return null;
  const root = value['root'];
  const cwd = value['cwd'];
  const registered = value['registered'];
  const worktree = value['worktree'];
  const ownerSessionId = value['ownerSessionId'];
  const ownerUnreadable = value['ownerUnreadable'];
  const locked = value['locked'];
  const reclaimable = value['reclaimable'];
  const retainReason = value['retainReason'];
  const observedAt = value['observedAt'];
  if (
    typeof root !== 'string' || root === '' ||
    typeof cwd !== 'string' || cwd === '' ||
    typeof registered !== 'boolean' ||
    !isCheckoutWorktreeState(worktree) ||
    !(ownerSessionId === null || (typeof ownerSessionId === 'string' && ownerSessionId !== '')) ||
    typeof ownerUnreadable !== 'boolean' ||
    typeof locked !== 'boolean' ||
    typeof reclaimable !== 'boolean' ||
    !(retainReason === null || isCheckoutRetainReason(retainReason)) ||
    typeof observedAt !== 'number' || !Number.isFinite(observedAt)
  ) return null;
  return {
    root,
    cwd,
    registered,
    worktree,
    ownerSessionId,
    ownerUnreadable,
    locked,
    reclaimable,
    retainReason,
    observedAt: observedAt as Millis,
  };
}

/**
 * Which checkout a session sits in, and whether it owns it.
 *
 * A session that is not inside a managed checkout is `checkout: null` — that
 * is an answer, not a missing field, and it is not the same as "this surface
 * cannot observe checkouts".
 */
function readSessionCheckoutView(value: unknown): HostSessionCheckoutView | null {
  if (!isRecord(value)) return null;
  const sessionId = value['sessionId'];
  const isOwner = value['isOwner'];
  if (typeof sessionId !== 'string' || sessionId === '' || typeof isOwner !== 'boolean') return null;
  const checkout = value['checkout'];
  if (checkout === null || checkout === undefined) {
    return { sessionId: sessionId as SessionId, checkout: null, isOwner };
  }
  const observed = readCheckoutObserved(checkout);
  if (observed === null) return null;
  return { sessionId: sessionId as SessionId, checkout: observed, isOwner };
}

/**
 * One observed pull request.
 *
 * `state` is carried through EXACTLY as the Host reported it, `unknown`
 * included. `unknown` means "the observation failed", and folding it into
 * `open` would turn "we could not look" into "the pull request is open" —
 * a fabricated fact that every downstream decision would then rest on. The
 * reason travels with it, unchanged.
 */
function readIntegrationRecord(value: unknown): HostIntegrationRecord | null {
  if (!isRecord(value)) return null;
  const repo = value['repo'];
  const prNumber = value['prNumber'];
  const state = value['state'];
  const headSha = value['headSha'];
  const baseRef = value['baseRef'];
  const url = value['url'];
  const observedAt = value['observedAt'];
  const observedError = value['observedError'];
  if (
    typeof repo !== 'string' || repo === '' ||
    typeof prNumber !== 'number' || !Number.isSafeInteger(prNumber) || prNumber <= 0 ||
    !isIntegrationState(state) ||
    !(headSha === null || typeof headSha === 'string') ||
    !(baseRef === null || typeof baseRef === 'string') ||
    !(url === null || typeof url === 'string') ||
    typeof observedAt !== 'number' || !Number.isFinite(observedAt) ||
    !(observedError === null || observedError === undefined || typeof observedError === 'string')
  ) return null;
  return {
    repo,
    prNumber,
    state,
    headSha,
    baseRef,
    url,
    observedAt: observedAt as Millis,
    observedError: observedError === undefined ? null : observedError,
  };
}

/**
 * The outcome of one explicit refresh, reported as it happened.
 *
 * `status` is carried through unchanged — a pass that wrote nothing and a
 * pass that could not read anything are different facts, and this transport
 * is not the one that decides which one it was.
 */
function readIntegrationSyncResult(value: unknown): HostIntegrationSyncResult | null {
  if (!isRecord(value)) return null;
  const status = value['status'];
  const writtenRaw = value['written'];
  const failedRaw = value['failed'];
  if (!isIntegrationSyncStatus(status) || !Array.isArray(writtenRaw) || !Array.isArray(failedRaw)) return null;
  const written: HostIntegrationSyncWritten[] = [];
  for (const entry of writtenRaw) {
    if (!isRecord(entry)) return null;
    const repo = entry['repo'];
    const prNumber = entry['prNumber'];
    if (typeof repo !== 'string' || repo === '' ||
        typeof prNumber !== 'number' || !Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
    written.push({ repo, prNumber });
  }
  const failed: HostIntegrationSyncFailure[] = [];
  for (const entry of failedRaw) {
    if (!isRecord(entry)) return null;
    const ref = entry['ref'];
    const reason = entry['reason'];
    if (typeof ref !== 'string' || ref === '' || typeof reason !== 'string') return null;
    failed.push({ ref, reason });
  }
  return { status, written, failed };
}

const CHECKOUT_WORKTREE_STATES = ['clean', 'dirty_tracked', 'untracked', 'ignored'] as const;

function isCheckoutWorktreeState(value: unknown): value is HostCheckoutObserved['worktree'] {
  return typeof value === 'string' &&
    (CHECKOUT_WORKTREE_STATES as readonly string[]).includes(value);
}

const CHECKOUT_RETAIN_REASONS = [
  'not_registered',
  'unreadable',
  'dirty_tracked',
  'untracked',
  'ignored',
  'locked',
  'detached_unreferenced',
  'reparse_point',
  'owner_alive',
  'cwd_inside',
] as const;

function isCheckoutRetainReason(value: unknown): value is HostCheckoutRetainReason {
  return typeof value === 'string' &&
    (CHECKOUT_RETAIN_REASONS as readonly string[]).includes(value);
}

const INTEGRATION_STATES = [
  'none',
  'draft',
  'open',
  'checks_failing',
  'checks_passing',
  'review_requested',
  'changes_requested',
  'approved',
  'merged',
  'closed_unmerged',
  'unknown',
] as const;

function isIntegrationState(value: unknown): value is HostIntegrationState {
  return typeof value === 'string' &&
    (INTEGRATION_STATES as readonly string[]).includes(value);
}

const INTEGRATION_SYNC_STATUSES = [
  'synced',
  'no_origin_remote',
  'no_checkpoints',
  'observation_failed',
] as const;

function isIntegrationSyncStatus(value: unknown): value is HostIntegrationSyncStatus {
  return typeof value === 'string' &&
    (INTEGRATION_SYNC_STATUSES as readonly string[]).includes(value);
}
