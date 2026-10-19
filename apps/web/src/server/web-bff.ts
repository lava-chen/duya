import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CURRENT_HOST_DECLARATION,
  type HostPermissionRequestResolveInput,
  type HostSessionListQuery,
  type RunEventEnvelope,
  type SessionId,
} from '@duya/agent-protocol';
import { HostSessionHttpClient, HostSessionHttpError } from '@duya/host/http-client';

const LOOPBACK = '127.0.0.1';
const MAX_JSON_BODY_BYTES = 64 * 1024;
const SSE_HEARTBEAT_MS = 15_000;
const MAX_SSE_BUFFERED_BYTES = 256 * 1024;
const VALID_PERMISSION_DECISIONS = ['allow', 'always', 'deny'] as const;

export interface WebBffOptions {
  /** Loopback Host origin. The Host bearer stays in this server process. */
  readonly hostOrigin: string;
  readonly hostToken: string;
  /** Defaults to an ephemeral port so callers can safely start multiple instances. */
  readonly port?: number;
}

export interface WebBffHandle {
  readonly origin: string;
  close(): Promise<void>;
}

/**
 * A same-origin, loopback-only browser facade over the typed Host HTTP API.
 * This deliberately exposes a small set of operations instead of proxying URLs.
 */
export async function createWebBff(options: WebBffOptions): Promise<WebBffHandle> {
  validateOptions(options);
  const client = new HostSessionHttpClient(options.hostOrigin, options.hostToken);
  const csrfToken = randomBytes(32).toString('hex');
  const activeStreams = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    void routeRequest({ request, response, client, csrfToken, activeStreams, origin: currentOrigin(server) })
      .catch(() => sendJson(response, 500, { error: { code: 'internal_error' } }));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(options.port ?? 0, LOOPBACK, () => {
      server.off('error', onError);
      resolve();
    });
  }).catch((error: unknown) => {
    server.close();
    throw error;
  });

  const origin = currentOrigin(server);
  let closed = false;
  return {
    origin,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const response of activeStreams) response.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

interface RequestContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly client: HostSessionHttpClient;
  readonly csrfToken: string;
  readonly activeStreams: Set<ServerResponse>;
  readonly origin: string;
}

async function routeRequest(context: RequestContext): Promise<void> {
  const { request, response, origin } = context;
  addSecurityHeaders(response);

  if (request.method === 'OPTIONS') {
    sendJson(response, 405, { error: { code: 'method_not_allowed' } });
    return;
  }

  if (!isExpectedHost(request, origin)) {
    sendJson(response, 403, { error: { code: 'host_not_allowed' } });
    return;
  }
  if (!isAllowedFetchSite(request)) {
    sendJson(response, 403, { error: { code: 'cross_site_request' } });
    return;
  }

  const requestUrl = parseRequestUrl(request.url, origin);
  if (!requestUrl) {
    sendJson(response, 400, { error: { code: 'invalid_url' } });
    return;
  }

  if (!requestUrl.pathname.startsWith('/api/')) {
    sendJson(response, 404, { error: { code: 'not_found' } });
    return;
  }

  if (!isAllowedOrigin(request, origin)) {
    sendJson(response, 403, { error: { code: 'origin_not_allowed' } });
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/bootstrap') {
    sendJson(response, 200, { apiVersion: 1, csrfToken: context.csrfToken });
    return;
  }

  if (isMutation(request.method) && !isValidCsrf(context)) {
    sendJson(response, 403, { error: { code: 'csrf_failed' } });
    return;
  }

  try {
    if (request.method === 'GET' && requestUrl.pathname === '/api/handshake') {
      await sendHandshake(context);
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/sessions') {
      const query = parseSessionListQuery(requestUrl.searchParams);
      if (!query) {
        sendJson(response, 400, { error: { code: 'invalid_session_query' } });
        return;
      }
      sendJson(response, 200, await context.client.list(query));
      return;
    }

    const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(requestUrl.pathname);
    if (request.method === 'GET' && sessionMatch) {
      const sessionId = decodePathPart(sessionMatch[1]);
      if (!sessionId) {
        sendJson(response, 400, { error: { code: 'invalid_session_id' } });
        return;
      }
      const session = await context.client.get(sessionId);
      sendJson(response, session ? 200 : 404, session ? { session } : { error: { code: 'session_not_found' } });
      return;
    }

    const messagesMatch = /^\/api\/sessions\/([^/]+)\/messages$/.exec(requestUrl.pathname);
    if (request.method === 'GET' && messagesMatch) {
      const sessionId = decodePathPart(messagesMatch[1]);
      const query = parseMessageQuery(requestUrl.searchParams);
      if (!sessionId || !query) {
        sendJson(response, 400, { error: { code: 'invalid_message_query' } });
        return;
      }
      sendJson(response, 200, await context.client.readMessages(sessionId, query));
      return;
    }

    const runsMatch = /^\/api\/sessions\/([^/]+)\/runs$/.exec(requestUrl.pathname);
    if (request.method === 'GET' && runsMatch) {
      const sessionId = decodePathPart(runsMatch[1]);
      const limit = parseLimit(requestUrl.searchParams.get('limit'), 50, 100);
      if (!sessionId || limit === null) {
        sendJson(response, 400, { error: { code: 'invalid_run_query' } });
        return;
      }
      sendJson(response, 200, { runs: await context.client.listAgentRunsBySession(sessionId, limit) });
      return;
    }

    const approvalsMatch = /^\/api\/sessions\/([^/]+)\/approvals$/.exec(requestUrl.pathname);
    if (request.method === 'GET' && approvalsMatch) {
      const sessionId = decodePathPart(approvalsMatch[1]);
      if (!sessionId) {
        sendJson(response, 400, { error: { code: 'invalid_session_id' } });
        return;
      }
      const requests = await context.client.listPendingPermissionRequests(sessionId);
      sendJson(response, 200, { approvals: requests });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/runs/start') {
      const body = await readJsonBody(request);
      if (!isStartRunInput(body)) {
        sendJson(response, 400, { error: { code: 'invalid_run_start' } });
        return;
      }
      sendJson(response, 202, await context.client.startAgentRun({
        sessionId: body.sessionId as SessionId,
        prompt: body.prompt,
        origin: 'user',
      }));
      return;
    }

    const cancelMatch = /^\/api\/runs\/([^/]+)\/cancel$/.exec(requestUrl.pathname);
    if (request.method === 'POST' && cancelMatch) {
      const runId = decodePathPart(cancelMatch[1]);
      const body = await readJsonBody(request);
      if (!runId || !isCancelRunInput(body)) {
        sendJson(response, 400, { error: { code: 'invalid_run_cancel' } });
        return;
      }
      sendJson(response, 200, await context.client.cancelAgentRun(runId, body.reason));
      return;
    }

    const approvalMatch = /^\/api\/approvals\/([^/]+)\/resolve$/.exec(requestUrl.pathname);
    if (request.method === 'POST' && approvalMatch) {
      const requestId = decodePathPart(approvalMatch[1]);
      const body = await readJsonBody(request);
      if (!requestId || !isPermissionDecision(body)) {
        sendJson(response, 400, { error: { code: 'invalid_approval_decision' } });
        return;
      }
      const input: HostPermissionRequestResolveInput = body.decision === 'deny'
        ? { status: 'deny', decision: 'deny' }
        : { status: 'allow', decision: body.decision === 'always' ? 'allow_for_session' : 'allow_once' };
      const result = await context.client.resolvePermissionRequest(requestId, input);
      sendJson(response, result ? 200 : 404, result ? { result } : { error: { code: 'approval_not_found' } });
      return;
    }

    const streamMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(requestUrl.pathname);
    if (request.method === 'GET' && streamMatch) {
      const runId = decodePathPart(streamMatch[1]);
      const afterSeq = parseEventCursor(request, requestUrl.searchParams);
      if (!runId || afterSeq === null) {
        sendJson(response, 400, { error: { code: 'invalid_run_event_cursor' } });
        return;
      }
      await streamRunEvents(context, runId, afterSeq);
      return;
    }

    sendJson(response, 404, { error: { code: 'not_found' } });
  } catch (error) {
    sendHostError(response, error);
  }
}

async function sendHandshake(context: RequestContext): Promise<void> {
  const handshake = await context.client.handshake(CURRENT_HOST_DECLARATION);
  // Host identity is an internal boundary detail. The browser receives only
  // protocol and capability facts needed to render its local client surface.
  sendJson(context.response, 200, {
    ok: handshake.ok,
    apiVersion: handshake.apiVersion,
    databaseReady: handshake.databaseReady,
    protocol: handshake.protocol,
    schemaRevision: handshake.schemaRevision,
    provides: handshake.provides ?? [],
    limits: handshake.limits,
    unsupported: handshake.unsupported ?? {},
    consumedBy: handshake.consumedBy ?? [],
  });
}

async function streamRunEvents(context: RequestContext, runId: string, afterSeq: number): Promise<void> {
  const { request, response, client, activeStreams } = context;
  const abortController = new AbortController();
  let ended = false;
  const abort = (): void => {
    if (ended) return;
    abortController.abort();
  };
  request.once('aborted', abort);
  response.once('close', abort);
  activeStreams.add(response);

  const heartbeat = setInterval(() => {
    if (!response.destroyed && !response.writableNeedDrain && response.writableLength <= MAX_SSE_BUFFERED_BYTES) {
      response.write(': keep-alive\n\n');
    }
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref?.();

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform, no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const iterator = client.watchAgentRunEvents(runId, { afterSeq, signal: abortController.signal })[Symbol.asyncIterator]();
  try {
    while (!abortController.signal.aborted && !response.destroyed) {
      const item = await iterator.next();
      if (item.done) break;
      if (!(await writeRunEvent(response, item.value, abortController.signal))) break;
    }
  } catch (error) {
    if (!abortController.signal.aborted && !response.destroyed) {
      const failure = safeHostError(error);
      response.write(`event: error\ndata: ${JSON.stringify(failure)}\n\n`);
    }
  } finally {
    ended = true;
    abortController.abort();
    clearInterval(heartbeat);
    request.off('aborted', abort);
    response.off('close', abort);
    activeStreams.delete(response);
    try {
      await iterator.return?.();
    } catch {
      // The request is already ending; releasing the upstream signal is enough.
    }
    if (!response.destroyed) response.end();
  }
}

async function writeRunEvent(
  response: ServerResponse,
  envelope: RunEventEnvelope,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted || response.destroyed) return false;
  const frame = `id: ${envelope.seq}\nevent: run\ndata: ${JSON.stringify(envelope)}\n\n`;
  if (response.write(frame)) return true;
  return new Promise<boolean>((resolve) => {
    const finish = (value: boolean): void => {
      response.off('drain', onDrain);
      response.off('close', onClose);
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onDrain = (): void => finish(!signal.aborted && !response.destroyed);
    const onClose = (): void => finish(false);
    const onAbort = (): void => finish(false);
    response.once('drain', onDrain);
    response.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function parseSessionListQuery(params: URLSearchParams): HostSessionListQuery | null {
  if (hasUnexpectedKeys(params, ['limit', 'includeArchived'])) return null;
  const limit = parseLimit(params.get('limit'), 50, 100);
  const includeArchived = parseBoolean(params.get('includeArchived'));
  if (limit === null || includeArchived === null) return null;
  return {
    limit,
    ...(includeArchived === undefined ? {} : { includeArchived }),
  };
}

function parseMessageQuery(params: URLSearchParams): { readonly cursor?: string; readonly limit?: number } | null {
  if (hasUnexpectedKeys(params, ['cursor', 'limit'])) return null;
  const cursor = params.get('cursor');
  const limit = parseLimit(params.get('limit'), 50, 100);
  if (limit === null || (cursor !== null && (cursor.length === 0 || cursor.length > 2_048))) return null;
  return {
    ...(cursor === null ? {} : { cursor }),
    limit,
  };
}

function parseEventCursor(request: IncomingMessage, params: URLSearchParams): number | null {
  if (hasUnexpectedKeys(params, ['afterSeq'])) return null;
  const header = request.headers['last-event-id'];
  const raw = typeof header === 'string' ? header : params.get('afterSeq');
  if (raw === null || raw === undefined) return 0;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function parseLimit(raw: string | null, defaultValue: number, maximum: number): number | null {
  if (raw === null) return defaultValue;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum ? value : null;
}

function parseBoolean(raw: string | null): boolean | undefined | null {
  if (raw === null) return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

function hasUnexpectedKeys(params: URLSearchParams, allowed: readonly string[]): boolean {
  for (const key of params.keys()) if (!allowed.includes(key)) return true;
  return false;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') return null;
  const declaredLength = request.headers['content-length'];
  if (declaredLength !== undefined && Number(declaredLength) > MAX_JSON_BODY_BYTES) {
    throw new RequestError(413, 'request_too_large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_JSON_BODY_BYTES) throw new RequestError(413, 'request_too_large');
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
  return isRecord(value) ? value : null;
}

function isStartRunInput(value: Record<string, unknown> | null): value is Record<string, unknown> & {
  readonly sessionId: string;
  readonly prompt: string;
} {
  return value !== null && hasOnlyKeys(value, ['sessionId', 'prompt']) &&
    isBoundedString(value.sessionId, 1, 256) && isBoundedString(value.prompt, 1, 64 * 1024);
}

function isCancelRunInput(value: Record<string, unknown> | null): value is Record<string, unknown> & { readonly reason?: string } {
  return value !== null && hasOnlyKeys(value, ['reason']) &&
    (value.reason === undefined || isBoundedString(value.reason, 1, 200));
}

function isPermissionDecision(value: Record<string, unknown> | null): value is Record<string, unknown> & {
  readonly decision: (typeof VALID_PERMISSION_DECISIONS)[number];
} {
  return value !== null && hasOnlyKeys(value, ['decision']) &&
    typeof value.decision === 'string' && VALID_PERMISSION_DECISIONS.includes(value.decision as (typeof VALID_PERMISSION_DECISIONS)[number]);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length >= minimum && value.length <= maximum;
}

function decodePathPart(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    const decoded = decodeURIComponent(value);
    if (!isBoundedString(decoded, 1, 256) || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function isMutation(method: string | undefined): boolean {
  return method !== 'GET' && method !== 'HEAD';
}

function isExpectedHost(request: IncomingMessage, origin: string): boolean {
  const expected = new URL(origin);
  return request.headers.host === expected.host;
}

function isAllowedFetchSite(request: IncomingMessage): boolean {
  const site = request.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin';
}

function isAllowedOrigin(request: IncomingMessage, origin: string): boolean {
  const supplied = request.headers.origin;
  if (supplied !== undefined) return supplied === origin;
  return !isMutation(request.method);
}

function isValidCsrf(context: RequestContext): boolean {
  const supplied = context.request.headers['x-duya-csrf'];
  if (typeof supplied !== 'string' || supplied.length !== context.csrfToken.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(context.csrfToken));
}

function parseRequestUrl(rawUrl: string | undefined, origin: string): URL | null {
  if (rawUrl === undefined || !rawUrl.startsWith('/') || rawUrl.startsWith('//')) return null;
  try {
    const parsed = new URL(rawUrl, origin);
    return parsed.origin === origin ? parsed : null;
  } catch {
    return null;
  }
}

function addSecurityHeaders(response: ServerResponse): void {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function sendHostError(response: ServerResponse, error: unknown): void {
  if (error instanceof RequestError) {
    sendJson(response, error.status, { error: { code: error.code } });
    return;
  }
  const failure = safeHostError(error);
  sendJson(response, failure.status, { error: { code: failure.code } });
}

function safeHostError(error: unknown): { readonly status: number; readonly code: string } {
  if (error instanceof HostSessionHttpError) {
    return { status: error.status, code: safeErrorCode(error.code) };
  }
  return { status: 502, code: 'upstream_unavailable' };
}

function safeErrorCode(code: string): string {
  return /^[a-z0-9_]{1,80}$/.test(code) ? code : 'upstream_error';
}

class RequestError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

function validateOptions(options: WebBffOptions): void {
  let host: URL;
  try {
    host = new URL(options.hostOrigin);
  } catch {
    throw new Error('Web BFF requires a valid loopback Host origin');
  }
  const hostname = host.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host.protocol !== 'http:' || host.username !== '' || host.password !== '' || host.pathname !== '/' ||
    host.search !== '' || host.hash !== '' || !['127.0.0.1', '::1'].includes(hostname)
  ) {
    throw new Error('Web BFF only connects to a loopback Host origin');
  }
  if (options.hostToken.trim().length === 0) throw new Error('Web BFF requires a Host bearer token');
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) {
    throw new Error('Web BFF port must be an integer between 0 and 65535');
  }
}

function currentOrigin(server: Server): string {
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error('Web BFF is not listening');
  return `http://${LOOPBACK}:${address.port}`;
}
