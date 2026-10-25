import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import {
  CURRENT_HOST_DECLARATION,
  isPermissionPolicyMode,
  type HostPermissionRequestResolveInput,
  type HostProviderCatalog,
  type HostSessionCreateInput,
  type HostSessionListQuery,
  type HostSessionPatch,
  type PermissionPolicyMode,
  type RunEventEnvelope,
  type SessionId,
} from '@duya/agent-protocol';
import type { HostLocalTurnSuggestionRecord } from '@duya/agent-protocol/turn-suggestion';
import { HostSessionHttpClient, HostSessionHttpError } from '@duya/host/http-client';

const LOOPBACK = '127.0.0.1';
const MAX_JSON_BODY_BYTES = 64 * 1024;
const SSE_HEARTBEAT_MS = 15_000;
const MAX_SSE_BUFFERED_BYTES = 256 * 1024;
const VALID_PERMISSION_DECISIONS = ['allow', 'always', 'deny'] as const;
/**
 * Thinking-effort levels the worker understands (`ModelThinkingLevel` in
 * `@duya/ai`). The browser may pick one; it may not invent one.
 */
const VALID_RUN_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";

export interface WebBffOptions {
  /** Loopback Host origin. The Host bearer stays in this server process. */
  readonly hostOrigin: string;
  readonly hostToken: string;
  /** Defaults to an ephemeral port so callers can safely start multiple instances. */
  readonly port?: number;
  /** Built browser assets served from the same origin as the API. */
  readonly staticRoot?: string;
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
    void routeRequest({
      request, response, client, csrfToken, activeStreams, origin: currentOrigin(server),
      ...(options.staticRoot === undefined ? {} : { staticRoot: options.staticRoot }),
    })
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
  readonly staticRoot?: string;
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

  if (!isAllowedOrigin(request, origin)) {
    sendJson(response, 403, { error: { code: 'origin_not_allowed' } });
    return;
  }

  if (context.staticRoot && (request.method === 'GET' || request.method === 'HEAD') &&
      !requestUrl.pathname.startsWith('/api/')) {
    await serveStatic(context.staticRoot, requestUrl.pathname, response, request.method === 'HEAD');
    return;
  }

  if (!requestUrl.pathname.startsWith('/api/')) {
    sendJson(response, 404, { error: { code: 'not_found' } });
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

    if (request.method === 'POST' && requestUrl.pathname === '/api/sessions') {
      const input = parseCreateSessionInput(await readJsonBody(request));
      if (input === null) {
        sendJson(response, 400, { error: { code: 'invalid_session_create' } });
        return;
      }
      sendJson(response, 201, { session: await context.client.create(input) });
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

    const sessionMutationMatch = /^\/api\/sessions\/([^/]+)$/.exec(requestUrl.pathname);
    if (sessionMutationMatch && request.method === 'PATCH') {
      const sessionId = decodePathPart(sessionMutationMatch[1]);
      const parsed = parseSessionPatch(await readJsonBody(request));
      if (!sessionId || parsed === null) {
        sendJson(response, 400, { error: { code: 'invalid_session_update' } });
        return;
      }
      const result = await context.client.update(sessionId, parsed.expectedUpdatedAt, parsed.patch);
      sendJson(response, result.updated ? 200 : result.reason === 'conflict' ? 409 : 404, result);
      return;
    }

    if (sessionMutationMatch && request.method === 'DELETE') {
      const sessionId = decodePathPart(sessionMutationMatch[1]);
      const expectedUpdatedAt = parseExpectedUpdatedAt(requestUrl.searchParams.get('expectedUpdatedAt'));
      if (!sessionId || expectedUpdatedAt === null || hasUnexpectedKeys(requestUrl.searchParams, ['expectedUpdatedAt'])) {
        sendJson(response, 400, { error: { code: 'invalid_session_delete' } });
        return;
      }
      const result = await context.client.delete(sessionId, expectedUpdatedAt);
      sendJson(response, result.deleted ? 200 : result.reason === 'conflict' ? 409 : 404, result);
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
      // `all=1` asks for the WHOLE transcript. The Host's paged read projects
      // the entire transcript on every page, so paging to the end of a
      // 10k-message session costs 100 projections of 10k rows.
      if (query.all) {
        sendJson(response, 200, await context.client.readAllMessages(sessionId, query.projection));
        return;
      }
      sendJson(response, 200, await context.client.readMessages(sessionId, query.paged));
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
        ...(body.model === undefined ? {} : { model: body.model }),
        ...(body.providerId === undefined ? {} : { providerId: body.providerId }),
        // The thinking level is a turn OPTION, not a protocol field: the Host
        // hands the options bag to the worker unchanged, which is the same
        // channel the Desktop renderer uses.
        ...(body.effort === undefined ? {} : { options: { effort: body.effort } }),
        // The permission mode the user picked travels as a TYPED field, not in
        // the options bag: the Host adjudicates that decision, and a bag that
        // carried it would let a caller name a mode the Host never resolved.
        ...(body.permissionMode === undefined ? {} : { permissionMode: body.permissionMode }),
        // A per-turn agent profile wins over the session's own.
        ...(body.agentProfileId === undefined ? {} : { agentProfileId: body.agentProfileId }),
        // The modes and tools the turn declares.
        ...(body.modes === undefined ? {} : { modes: body.modes }),
        ...(body.tools === undefined ? {} : { tools: body.tools }),
      }));
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/workspaces/local-directories') {
      const body = await readJsonBody(request);
      if (!isRegisterDirectoryInput(body)) {
        sendJson(response, 400, { error: { code: 'invalid_workspace_path' } });
        return;
      }
      const workspace = await context.client.registerLocalDirectory(body.directory);
      sendJson(response, 201, { workspace });
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/providers/catalog') {
      sendJson(response, 200, { catalog: await readProviderCatalog(context.client) });
      return;
    }

    // The end-of-turn suggestion the worker predicted for this session.
    if (request.method === 'GET' && requestUrl.pathname === '/api/turn-suggestions/latest') {
      const sessionId = requestUrl.searchParams.get('sessionId');
      if (!isBoundedString(sessionId, 1, 200)) {
        sendJson(response, 400, { error: { code: 'invalid_turn_suggestion_query' } });
        return;
      }
      const suggestion = await readLatestTurnSuggestion(context.client, sessionId);
      sendJson(response, 200, { suggestion });
      return;
    }

    // The checkout and integration namespaces (plan 621). The BFF is a
    // FORWARDER here: the Host owns the session -> checkout -> pull-request
    // mapping, and a facade that re-derived it would be a second answer to the
    // same question. So the question goes up unchanged and the answer comes
    // back unchanged — including a refusal, which is an answer and not a
    // failure.
    if (request.method === 'GET' && requestUrl.pathname === '/api/checkouts') {
      const query = parseCheckoutQuery(requestUrl.searchParams);
      if (query === null) {
        sendJson(response, 400, { error: { code: 'invalid_checkout_query' } });
        return;
      }
      const checkout = query.kind === 'session'
        ? await context.client.observeCheckoutForSession(query.sessionId)
        : await context.client.observeCheckoutByRoot(query.root);
      sendJson(response, 200, { checkout });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/checkouts/control') {
      const body = await readJsonBody(request);
      if (!isRecord(body) || !isBoundedString(body.sessionId, 1, 256) || !isRecord(body.command)) {
        sendJson(response, 400, { error: { code: 'invalid_checkout_command' } }); return;
      }
      const result = await context.client.controlSessionCheckout(body.sessionId, body.command as unknown as import('@duya/agent-protocol').SessionCheckoutCommand);
      sendJson(response, 200, { result }); return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/checkouts/reclaim') {
      const body = await readJsonBody(request);
      if (!isReclaimInput(body)) {
        sendJson(response, 400, { error: { code: 'invalid_checkout_query' } });
        return;
      }
      // `removed: false` is a 200: the Host declined and nothing was deleted.
      const result = await context.client.requestCheckoutReclaim(body.root);
      sendJson(response, 200, { result });
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/integrations') {
      const sessionId = requestUrl.searchParams.get('sessionId');
      if (hasUnexpectedKeys(requestUrl.searchParams, ['sessionId']) || !isBoundedString(sessionId, 1, 4096)) {
        sendJson(response, 400, { error: { code: 'invalid_integration_query' } });
        return;
      }
      const records = await context.client.observeIntegrationsForSession(sessionId);
      sendJson(response, 200, { records });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/integrations/sync') {
      const body = await readJsonBody(request);
      if (!isIntegrationSyncInput(body)) {
        sendJson(response, 400, { error: { code: 'invalid_integration_sync' } });
        return;
      }
      const result = await context.client.syncIntegrations(body.sessionId);
      sendJson(response, 200, { result });
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

/**
 * The Host's provider catalog, or `null` when it has none.
 *
 * A Host composed without the local provider catalog refuses the read with a
 * 404. That is the absence of a roster, not a failure of the read, so it
 * becomes `null` here and the browser draws nothing — a shape a screen can
 * show, where a failed request is not.
 */
async function readProviderCatalog(client: HostSessionHttpClient): Promise<HostProviderCatalog | null> {
  try {
    return await client.getProviderCatalog();
  } catch (error) {
    if (error instanceof HostSessionHttpError && error.status === 404) return null;
    throw error;
  }
}

/**
 * The Host's end-of-turn suggestion, or `null` when it has none.
 *
 * A Host that does not serve suggestions refuses the read with a 404; that is
 * the absence of a suggestion, not a failure of the read, so it becomes
 * `null` here and the composer simply shows its ordinary placeholder.
 */
async function readLatestTurnSuggestion(
  client: HostSessionHttpClient,
  sessionId: string,
): Promise<HostLocalTurnSuggestionRecord | null> {
  try {
    return await client.getLatestTurnSuggestion(sessionId);
  } catch (error) {
    if (error instanceof HostSessionHttpError && error.status === 404) return null;
    throw error;
  }
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
  if (hasUnexpectedKeys(params, ['limit', 'includeArchived', 'cursor'])) return null;
  const limit = parseLimit(params.get('limit'), 50, 100);
  const includeArchived = parseBoolean(params.get('includeArchived'));
  const cursor = params.get('cursor');
  if (limit === null || includeArchived === null || (cursor !== null && (cursor.length === 0 || cursor.length > 2_048))) return null;
  return {
    limit,
    ...(includeArchived === undefined ? {} : { includeArchived }),
    ...(cursor === null ? {} : { cursor }),
  };
}

function parseCreateSessionInput(value: Record<string, unknown> | null): HostSessionCreateInput | null {
  const allowed = [
    'workspaceId', 'workspaceRootId', 'workspaceRelativePath', 'title', 'projectName',
    'model', 'providerId', 'mode', 'permissionMode', 'agentProfileId', 'parentSessionId',
    'agentType', 'agentName', 'draft',
  ] as const;
  if (value === null || !hasOnlyKeys(value, allowed)) return null;
  if (!isBoundedString(value.workspaceId, 1, 256) ||
      !(value.workspaceRootId === null || isBoundedString(value.workspaceRootId, 1, 256))) return null;
  if (value.workspaceRelativePath !== undefined && !isWorkspaceRelativePath(value.workspaceRelativePath)) return null;
  for (const key of ['title', 'projectName', 'model', 'providerId', 'mode', 'agentType', 'agentName'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 300)) return null;
  }
  if (value.permissionMode !== undefined &&
      (typeof value.permissionMode !== 'string' || !['default', 'auto', 'full_access'].includes(value.permissionMode))) return null;
  if (value.agentProfileId !== undefined && value.agentProfileId !== null && !isBoundedString(value.agentProfileId, 1, 256)) return null;
  if (value.parentSessionId !== undefined && value.parentSessionId !== null && !isBoundedString(value.parentSessionId, 1, 256)) return null;
  if (value.draft !== undefined && value.draft !== null && (typeof value.draft !== 'string' || value.draft.length > 64 * 1024)) return null;
  return value as HostSessionCreateInput;
}

function parseSessionPatch(value: Record<string, unknown> | null): { readonly expectedUpdatedAt?: number; readonly patch: HostSessionPatch } | null {
  if (value === null || !hasOnlyKeys(value, ['expectedUpdatedAt', 'patch']) || !isRecord(value.patch)) return null;
  const expectedUpdatedAt = value.expectedUpdatedAt;
  if (expectedUpdatedAt !== undefined && (!Number.isSafeInteger(expectedUpdatedAt) || (expectedUpdatedAt as number) < 0)) return null;
  const patch = value.patch;
  const allowed = ['title', 'projectName', 'status', 'model', 'providerId', 'mode', 'permissionMode', 'agentProfileId', 'parentSessionId', 'agentType', 'agentName', 'draft'];
  if (!hasOnlyKeys(patch, allowed)) return null;
  for (const key of ['title', 'projectName', 'status', 'model', 'providerId', 'mode', 'agentType', 'agentName'] as const) {
    if (patch[key] !== undefined && (typeof patch[key] !== 'string' || patch[key].length > 300)) return null;
  }
  if (patch.permissionMode !== undefined &&
      (typeof patch.permissionMode !== 'string' || !['default', 'auto', 'full_access'].includes(patch.permissionMode))) return null;
  if (patch.agentProfileId !== undefined && patch.agentProfileId !== null && !isBoundedString(patch.agentProfileId, 1, 256)) return null;
  if (patch.parentSessionId !== undefined && patch.parentSessionId !== null && !isBoundedString(patch.parentSessionId, 1, 256)) return null;
  if (patch.draft !== undefined && patch.draft !== null && (typeof patch.draft !== 'string' || patch.draft.length > 64 * 1024)) return null;
  return { ...(typeof expectedUpdatedAt === 'number' ? { expectedUpdatedAt } : {}), patch: patch as HostSessionPatch };
}

function parseExpectedUpdatedAt(raw: string | null): number | null | undefined {
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function isWorkspaceRelativePath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2_048 && !value.startsWith('/') &&
    !value.startsWith('\\') && !/^[a-zA-Z]:/.test(value) && !value.includes('\\') &&
    !value.split('/').includes('..') && !value.includes('\0');
}

/**
 * The message query of `GET /api/sessions/:id/messages`.
 *
 * `all=1` is the whole transcript: the Host projects it ONCE and hands back
 * every row. It is the opposite of a page, so it cannot carry a cursor or a
 * limit — asking for both is a contradiction, and the route refuses it rather
 * than quietly ignoring one of them.
 */
function parseMessageQuery(params: URLSearchParams): {
  readonly all: boolean;
  readonly projection: { readonly includeSuperseded?: boolean };
  readonly paged: { readonly cursor?: string; readonly limit: number; readonly includeSuperseded?: boolean };
} | null {
  if (hasUnexpectedKeys(params, ['cursor', 'limit', 'includeSuperseded', 'all'])) return null;
  const cursor = params.get('cursor');
  const limit = parseLimit(params.get('limit'), 50, 100);
  const includeSuperseded = parseBoolean(params.get('includeSuperseded'));
  const all = params.get('all');
  if (limit === null || includeSuperseded === null ||
      (cursor !== null && (cursor.length === 0 || cursor.length > 2_048))) return null;
  if (all !== null && all !== '1') return null;
  const whole = all === '1';
  // A whole read and a page are contradictory: refusing beats ignoring one.
  if (whole && (cursor !== null || params.has('limit'))) return null;
  return {
    all: whole,
    projection: {
      ...(includeSuperseded === undefined ? {} : { includeSuperseded }),
    },
    paged: {
      ...(cursor === null ? {} : { cursor }),
      limit,
      ...(includeSuperseded === undefined ? {} : { includeSuperseded }),
    },
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

/**
 * The run-start body the browser may send.
 *
 * A local path is NOT among them: the worker runs inside a workspace the Host
 * registered, and a directory the browser names would move that boundary.
 *
 * The turn's CONFIGURATION is: the permission mode the user picked, the agent
 * profile, the modes and tools the turn declares. Those are the same fields the
 * Desktop renderer sends, and the Host adjudicates them the same way — a
 * browser that could not name them would be a browser whose turns silently
 * ran under different rules than the user's.
 */
function isStartRunInput(value: Record<string, unknown> | null): value is Record<string, unknown> & {
  readonly sessionId: string;
  readonly prompt: string;
  readonly model?: string;
  readonly providerId?: string;
  readonly effort?: string;
  readonly permissionMode?: PermissionPolicyMode;
  readonly agentProfileId?: string | null;
  readonly modes?: readonly string[];
  readonly tools?: readonly string[];
} {
  return value !== null && hasOnlyKeys(value, [
    'sessionId', 'prompt', 'model', 'providerId', 'effort',
    'permissionMode', 'agentProfileId', 'modes', 'tools',
  ]) &&
    isBoundedString(value.sessionId, 1, 256) && isBoundedString(value.prompt, 1, 64 * 1024) &&
    (value.model === undefined || isBoundedString(value.model, 1, 300)) &&
    (value.providerId === undefined || isBoundedString(value.providerId, 1, 300)) &&
    (value.effort === undefined ||
      (typeof value.effort === 'string' && VALID_RUN_EFFORTS.includes(value.effort as (typeof VALID_RUN_EFFORTS)[number]))) &&
    (value.permissionMode === undefined || isPermissionPolicyMode(value.permissionMode)) &&
    (value.agentProfileId === undefined || value.agentProfileId === null ||
      isBoundedString(value.agentProfileId, 1, 256)) &&
    (value.modes === undefined || isNameList(value.modes)) &&
    (value.tools === undefined || isNameList(value.tools));
}

/**
 * A list of names the turn declares.
 *
 * An empty name is refused rather than dropped: a list with a hole in it reads
 * as a shorter list, and the difference is invisible in the record.
 */
function isNameList(value: unknown): value is readonly string[] {
  return Array.isArray(value) &&
    value.length <= 64 &&
    value.every((entry) => typeof entry === 'string' && entry.trim().length > 0 && entry.length <= 300);
}

/**
 * The directory the browser asks the Host to register as a workspace.
 *
 * A local path IS among them, and that is the point: the Host resolves the
 * path against the machine it runs on and returns a workspace BINDING, which
 * is what a session needs. The browser never gets to name a path the worker
 * runs in directly — it names a directory to be registered, and the Host
 * decides what that becomes.
 */
function isRegisterDirectoryInput(value: Record<string, unknown> | null): value is Record<string, unknown> & {
  readonly directory: string;
} {
  return value !== null && hasOnlyKeys(value, ['directory']) &&
    isBoundedString(value.directory, 1, 4_096) &&
    // A relative path would resolve against the BFF's own working directory,
    // which is not a workspace anybody asked for.
    path.isAbsolute(value.directory);
}

function isCancelRunInput(value: Record<string, unknown> | null): value is Record<string, unknown> & { readonly reason?: string } {
  return value !== null && hasOnlyKeys(value, ['reason']) &&
    (value.reason === undefined || isBoundedString(value.reason, 1, 200));
}

/**
 * Which checkout the browser is asking about.
 *
 * Exactly one selector: naming both is ambiguous, and naming neither would
 * have to fall back to a scan of every checkout on the machine — a question
 * the browser has no business asking.
 */
type CheckoutQuery =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'root'; readonly root: string };

function parseCheckoutQuery(params: URLSearchParams): CheckoutQuery | null {
  if (hasUnexpectedKeys(params, ['sessionId', 'root'])) return null;
  const sessionId = params.get('sessionId');
  const root = params.get('root');
  if ((sessionId === null) === (root === null)) return null;
  if (sessionId !== null) {
    return isBoundedString(sessionId, 1, 4096) ? { kind: 'session', sessionId } : null;
  }
  return isBoundedString(root, 1, 4096) ? { kind: 'root', root } : null;
}

/**
 * The checkout the browser asks the Host to remove.
 *
 * The path is the checkout's identity, so it travels in the body and it is
 * bounded exactly like the Host bounds it. Nothing else may travel with it:
 * a reclaim request that carried a verdict would be a client deciding on the
 * Host's authority.
 */
function isReclaimInput(value: Record<string, unknown> | null): value is Record<string, unknown> & {
  readonly root: string;
} {
  return value !== null && hasOnlyKeys(value, ['root']) && isBoundedString(value.root, 1, 4096);
}

/**
 * The session whose pull requests the browser asks the Host to re-read.
 *
 * The refresh is session-scoped because that is the Host's write side: one
 * pass walks session -> cwd -> origin -> checkpoint refs -> pull requests.
 */
function isIntegrationSyncInput(value: Record<string, unknown> | null): value is Record<string, unknown> & {
  readonly sessionId: string;
} {
  return value !== null && hasOnlyKeys(value, ['sessionId']) && isBoundedString(value.sessionId, 1, 4096);
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
  if (site === undefined || site === 'same-origin') return true;
  return site === 'none' && request.method === 'GET' &&
    request.headers['sec-fetch-mode'] === 'navigate' &&
    request.headers['sec-fetch-dest'] === 'document';
}

async function serveStatic(root: string, pathname: string, response: ServerResponse, headOnly: boolean): Promise<void> {
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    sendJson(response, 400, { error: { code: 'invalid_static_path' } });
    return;
  }
  if (relativePath.includes('\0') || relativePath.split(/[\\/]/).includes('..')) {
    sendJson(response, 400, { error: { code: 'invalid_static_path' } });
    return;
  }
  if (!(relativePath === 'index.html' || relativePath.startsWith('assets/') || relativePath.startsWith('fonts/') ||
      relativePath === 'icon.png' || relativePath === 'favicon.ico')) {
    if (path.extname(relativePath) !== '') {
      sendJson(response, 404, { error: { code: 'not_found' } });
      return;
    }
    relativePath = '';
  }
  const rootPath = path.resolve(root);
  let rootRealPath: string;
  try {
    rootRealPath = await realpath(rootPath);
  } catch {
    sendJson(response, 404, { error: { code: 'not_found' } });
    return;
  }
  const requestedPath = path.resolve(rootPath, relativePath || 'index.html');
  if (requestedPath !== rootPath && !requestedPath.startsWith(`${rootPath}${path.sep}`)) {
    sendJson(response, 400, { error: { code: 'invalid_static_path' } });
    return;
  }
  try {
    const requestedRealPath = await realpath(requestedPath);
    if (requestedRealPath !== rootRealPath && !requestedRealPath.startsWith(`${rootRealPath}${path.sep}`)) {
      sendJson(response, 404, { error: { code: 'not_found' } });
      return;
    }
    const contents = await readFile(requestedRealPath);
    sendStaticBytes(response, requestedRealPath, contents, headOnly);
    return;
  } catch {
    // Browser routes fall back to the application shell; unknown assets do not.
  }
  if (path.extname(relativePath) !== '') {
    sendJson(response, 404, { error: { code: 'not_found' } });
    return;
  }
  const indexPath = path.join(rootPath, 'index.html');
  try {
    const indexRealPath = await realpath(indexPath);
    if (indexRealPath !== rootRealPath && !indexRealPath.startsWith(`${rootRealPath}${path.sep}`)) {
      sendJson(response, 404, { error: { code: 'not_found' } });
      return;
    }
    const contents = await readFile(indexRealPath);
    sendStaticBytes(response, indexRealPath, contents, headOnly);
  } catch {
    sendJson(response, 404, { error: { code: 'not_found' } });
  }
}

function sendStaticBytes(response: ServerResponse, filePath: string, contents: Buffer, headOnly: boolean): void {
  const contentTypeByExtension: Readonly<Record<string, string>> = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  const contentType = contentTypeByExtension[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  if (response.destroyed || response.headersSent) return;
  response.writeHead(200, { 'content-type': contentType, 'content-length': contents.byteLength });
  response.end(headOnly ? undefined : contents);
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
  response.setHeader('content-security-policy', CONTENT_SECURITY_POLICY);
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
