/**
 * The Host boundary the shared renderer speaks through.
 *
 * ## Why a port and not a URL
 *
 * The Web renderer reaches a Host through a same-origin BFF, so it can use
 * `fetch` directly. The Desktop renderer cannot: the Host's HTTP server
 * refuses every request that carries an `Origin` header (`origin_not_allowed`,
 * a CSRF defence), and a browser `fetch` from a `file://` page always carries
 * one. The Desktop's Host also listens on a random port behind a bearer token
 * that the renderer has no way to learn.
 *
 * So the Desktop reaches the Host through an Electron bridge owned by the Main
 * process, and this file describes what that bridge has to deliver. Expressing
 * it as a typed PORT rather than as a URL keeps the shared renderer honest:
 * there is exactly one set of Host operations, one wire contract, and one
 * place where a surface says which of them it can actually perform.
 *
 * ## What a bridge must NOT do
 *
 * It must not re-decide anything. The Host owns sessions, runs, approvals and
 * their durable ledgers; a bridge that answers from a cache, or that papers
 * over a refusal, becomes a second source of truth with none of the Host's
 * guarantees. Every method below either returns what the Host returned, or
 * throws the Host's refusal.
 */

import type {
  AgentRunRecord,
  CancelAgentRunResult,
  HostMessagePage,
  HostMessageReadAllQuery,
  HostMessageReadQuery,
  HostPermissionRequest,
  HostPermissionRequestResolveInput,
  HostProviderCatalog,
  HostSessionCreateInput,
  HostSessionDeleteResult,
  HostSessionListQuery,
  HostSessionPage,
  HostSessionPatch,
  HostSessionRecord,
  HostSessionUpdateResult,
  RunEventEnvelope,
  RunId,
  SessionId,
  StartAgentRunInput,
  StartAgentRunResult,
} from '@duya/agent-protocol';
import type { RunStreamOpener } from '../session/run-event-stream.js';

/**
 * The Host operations the shared renderer needs.
 *
 * Every method is request/response. The run event stream is NOT here: it is a
 * separate, long-lived channel whose lifetime is bound to a selection, and
 * mixing the two would make a hung stream block a session rename.
 */
export interface HostApiBridge {
  listSessions(query?: HostSessionListQuery): Promise<HostSessionPage>;
  getSession(sessionId: SessionId): Promise<HostSessionRecord | null>;
  createSession(input: HostSessionCreateInput): Promise<HostSessionRecord>;
  updateSession(
    sessionId: SessionId,
    expectedUpdatedAt: number | undefined,
    patch: HostSessionPatch,
  ): Promise<HostSessionUpdateResult>;
  deleteSession(sessionId: SessionId, expectedUpdatedAt?: number): Promise<HostSessionDeleteResult>;
  readMessages(sessionId: SessionId, query?: HostMessageReadQuery): Promise<HostMessagePage>;
  /**
   * The WHOLE message projection, projected once.
   *
   * `readMessages` pages, and every page re-projects the entire transcript: a
   * client that reads a transcript end to end through the pages pays for the
   * transcript once PER PAGE (measured on a 10k-message session: 16.7s of
   * paging against 0.3s for one projection). A client that wants the whole
   * transcript asks for it here.
   */
  readAllMessages(sessionId: SessionId, query?: HostMessageReadAllQuery): Promise<HostMessagePage>;

  listRuns(sessionId: SessionId, limit?: number): Promise<readonly AgentRunRecord[]>;
  startRun(input: StartAgentRunInput): Promise<StartAgentRunResult>;
  cancelRun(runId: RunId, reason?: string): Promise<CancelAgentRunResult>;
  /** One durable window of a run's events, from the Host's ledger. */
  readRunEvents(runId: RunId, afterSeq: number, limit?: number): Promise<readonly RunEventEnvelope[]>;

  listPendingApprovals(sessionId?: SessionId): Promise<readonly HostPermissionRequest[]>;
  resolveApproval(
    requestId: string,
    input: HostPermissionRequestResolveInput,
  ): Promise<HostPermissionRequest | null>;

  /**
   * The configured provider/model roster.
   *
   * This is the roster the Host adjudicates a turn's model against, so it is
   * the roster a surface has to show: a browser that offered a model the
   * Host would refuse would be offering a lie.
   *
   * OPTIONAL. A bridge whose Host has no provider catalog leaves the method
   * out, and `null` says the same thing when the method is there but the Host
   * refuses the read: there is no roster, which is the truth rather than an
   * error to dress up.
   */
  getProviderCatalog?(): Promise<HostProviderCatalog | null>;

  /**
   * Opens the run's live event stream.
   *
   * OPTIONAL. A bridge that cannot stream returns `undefined`, and the caller
   * falls back to polling `readRunEvents`. That fallback is slower but exact:
   * the cursor is the same, so the projection converges on the same state.
   */
  openRunStream?: RunStreamOpener;
}

/** A `fetch` the bridge can use. Injected so a test can supply its own. */
export type HostFetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    cache?: string;
  },
) => Promise<HostFetchResponse>;

export interface HostFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  readonly body: ReadableStream<Uint8Array> | null;
}

export interface HostHttpBridgeOptions {
  /** Origin of the Host HTTP API, e.g. `http://127.0.0.1:53124`. */
  readonly origin: string;
  /** Bearer token the Host's HTTP server demands. */
  readonly token: string;
  readonly fetchImpl?: HostFetchLike;
}

/**
 * A bridge that speaks the Host's own HTTP contract.
 *
 * Used directly by the Web lane's acceptance fixture and by any surface whose
 * process can reach the Host without a browser `Origin` header. In the Electron
 * renderer it works only if the bridge also arranges for the Host to accept
 * this origin — which is a Main-process concern, not this file's.
 */
export function createHostHttpBridge(options: HostHttpBridgeOptions): HostApiBridge {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init as RequestInit) as unknown as Promise<HostFetchResponse>);
  const base = options.origin.replace(/\/+$/, '');

  const request = async <T>(path: string, init: {
    method?: string;
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
    signal?: AbortSignal;
  }): Promise<T> => {
    const url = `${base}${path}${init.query === undefined ? '' : `?${toQuery(init.query)}`}`;
    const response = await fetchImpl(url, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${options.token}`,
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new HostApiError(response.status, readErrorCode(detail) ?? `host_http_${response.status}`);
    }
    return (await response.json()) as T;
  };

  return {
    listSessions: (query) => request<HostSessionPage>('/v1/sessions', { query: toQueryValues(query) }),
    getSession: async (sessionId) => {
      const page = await request<{ session: HostSessionRecord }>(
        `/v1/sessions/${encodeURIComponent(sessionId)}`,
        {},
      );
      return page.session ?? null;
    },
    createSession: async (input) => {
      const page = await request<{ session: HostSessionRecord }>('/v1/sessions', { method: 'POST', body: input });
      return page.session;
    },
    updateSession: (sessionId, expectedUpdatedAt, patch) => request<HostSessionUpdateResult>(
      `/v1/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'PATCH', body: { ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }), patch } },
    ),
    deleteSession: (sessionId, expectedUpdatedAt) => request<HostSessionDeleteResult>(
      `/v1/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: 'DELETE',
        query: expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt },
      },
    ),
    readMessages: (sessionId, query) => request<HostMessagePage>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      { query: toQueryValues(query) },
    ),
    readAllMessages: (sessionId, query) => request<HostMessagePage>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      { query: { all: '1', ...toQueryValues(query) } },
    ),
    listRuns: (sessionId, limit) => request<readonly AgentRunRecord[]>(
      '/v1/agent-runs',
      { query: { sessionId, ...(limit === undefined ? {} : { limit }) } },
    ),
    startRun: (input) => request<StartAgentRunResult>(
      '/v1/agent-runs/start',
      { method: 'POST', body: input },
    ),
    cancelRun: (runId, reason) => request<CancelAgentRunResult>(
      `/v1/agent-runs/${encodeURIComponent(runId)}/cancel`,
      { method: 'POST', body: reason === undefined ? {} : { reason } },
    ),
    readRunEvents: async (runId, afterSeq, limit) => {
      const page = await request<{ events: readonly RunEventEnvelope[] }>(
        `/v1/agent-runs/${encodeURIComponent(runId)}/events`,
        { query: { afterSeq, ...(limit === undefined ? {} : { limit }) } },
      );
      return page.events ?? [];
    },
    listPendingApprovals: (sessionId) => request<readonly HostPermissionRequest[]>(
      '/v1/permission-requests',
      { query: sessionId === undefined ? {} : { sessionId } },
    ),
    resolveApproval: async (requestId, input) => {
      const page = await request<{ permission: HostPermissionRequest }>(
        `/v1/permission-requests/${encodeURIComponent(requestId)}/resolve`,
        { method: 'POST', body: input },
      );
      return page.permission ?? null;
    },
    getProviderCatalog: async () => {
      try {
        const page = await request<{ catalog: HostProviderCatalog }>('/v1/local/provider-catalog', {});
        return page.catalog;
      } catch (error) {
        // A Host composed WITHOUT the local provider catalog refuses the
        // read with a 404. That is the absence of a roster, not a failure of
        // the read, and it is the only status that means it here.
        if (error instanceof HostApiError && error.status === 404) return null;
        throw error;
      }
    },
    openRunStream: async (runId, afterSeq, signal) => {
      const url = `${base}/v1/agent-runs/${encodeURIComponent(runId)}/events/stream?${toQuery({ afterSeq })}`;
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${options.token}`, accept: 'text/event-stream' },
        signal,
      });
      if (!response.ok) throw new HostApiError(response.status, `host_http_${response.status}`);
      if (response.body === null) throw new HostApiError(response.status, 'host_event_stream_missing_body');
      return response.body;
    },
  };
}

/** A refusal the Host made, carried with its status and code. */
export class HostApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`${code} (host status ${status})`);
    this.name = 'HostApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Flatten a query object into URL query values.
 *
 * The parameter is `object`, not `Record<string, unknown>`: the protocol's
 * query types are plain interfaces, and an interface has NO implicit index
 * signature, so TypeScript refuses to assign one to a `Record<string, unknown>`
 * even when every one of its members is a valid query value. Widening here
 * keeps the call sites free of casts and still rejects nothing that `Object.entries`
 * can enumerate.
 */
function toQueryValues(query: object | undefined): Record<string, string | number | boolean | undefined> {
  const values: Record<string, string | number | boolean | undefined> = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) values[key] = String(item);
      continue;
    }
    values[key] = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : String(value);
  }
  return values;
}

function toQuery(query: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join('&');
}

function readErrorCode(detail: unknown): string | null {
  if (typeof detail !== 'object' || detail === null) return null;
  const error = (detail as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}
