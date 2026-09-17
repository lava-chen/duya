import * as http from 'http';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { ChildProcess, execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { SessionManager } from './session-store';
import { SessionState } from './types';
import { WorkerManager } from './worker-manager';
import { CheckpointBatcher } from './checkpoint-batcher';
import { Logger } from './logger';
import { toLLMProvider, type ApiProvider } from '../../config/provider-types';
import { calculateMaxConcurrentWorkers, getWorkerMemoryThreshold } from './worker-limits';
import { acquireChatLock, releaseChatLock, type ChatLockOrigin } from './chat-runtime-lock';
import { parseAgentIdFromBotSession } from '../../wake/bot-session-id';
import { buildCronProviderConfig, resolveCronModel } from '../../automation/provider-config';
import { readConfigAgents } from '../../../packages/agent/src/agent-profile/config-agents.js';
import { normalizePath } from '../../memory-state/pathUtils';

/**
 * Detect whether the project has a `.duya/references/` directory.
 * When true, the agent's system prompt includes a section instructing it to
 * consult those files as higher-authority context. Cheap `existsSync` call —
 * sub-millisecond.
 */
export function detectReferencesEnabled(workingDirectory?: string): boolean {
  if (!workingDirectory) return false;
  return existsSync(join(workingDirectory, '.duya', 'references'));
}

/**
 * Return the amount of memory that is effectively available for new work.
 *
 * On macOS, Node's `os.freemem()` only reports pages that are completely free,
 * which ignores the large pool of inactive/speculative/purgeable pages that the
 * kernel can reclaim on demand. This makes the memory ratio look dangerously
 * high on Intel and Apple Silicon Macs even when memory pressure is moderate.
 *
 * `vm_stat` reports the same counters Activity Monitor uses, so we include
 * free + inactive + speculative + purgeable pages as "available". On non-macOS
 * platforms we fall back to `os.freemem()`.
 */
function getAvailableMemory(): number {
  if (process.platform !== 'darwin') {
    return os.freemem();
  }

  try {
    const output = execSync('vm_stat', { encoding: 'utf8', timeout: 1000 });
    const pageSizeMatch = output.match(/page size of (\d+) bytes/);
    const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 16384;

    const parsePages = (label: string): number => {
      const match = output.match(new RegExp(`${label}:\\s+(\\d+)\\.`));
      return match ? parseInt(match[1], 10) : 0;
    };

    const free = parsePages('Pages free');
    const inactive = parsePages('Pages inactive');
    const speculative = parsePages('Pages speculative');
    const purgeable = parsePages('Pages purgeable');

    return (free + inactive + speculative + purgeable) * pageSize;
  } catch {
    // If vm_stat fails for any reason, fall back to the conservative value.
    return os.freemem();
  }
}

/**
 * Plan 506 — bot binding config fallback for `providerConfig.model`.
 *
 * A bot session (`bot:<agentId>`) wakes its worker with an HTTP body that
 * carries the RENDERER's currently active provider/model, NOT the bot's own
 * binding. When the user has never opened Settings the body has no model at
 * all, and the worker crashes with "Model is required" before the channel
 * handler can ever send a reply. This helper resolves the bot's binding
 * config (`[agents.<id>]` in `~/.duya/config.toml`) and patches the empty
 * fields with the bot's own provider/model — resolved through the provider
 * store so `apiKey`/`baseURL`/`authStyle` line up automatically. Pure
 * function so it's directly unit-testable (Plan 506 review note: keep
 * adapter-free — never throws for "no binding", returns the input
 * unchanged so the existing `!providerConfig.model` guard at L617 still
 * surfaces a 400 to the user).
 */
export async function resolveBotProviderConfigFallback(
  botAgentId: string,
  currentProviderConfig: Record<string, unknown> | undefined,
  deps: BotProviderConfigFallbackDeps = {},
): Promise<Record<string, unknown> | undefined> {
  // Only act when the body actually has a gap. If the renderer already
  // supplied a model, respect it — user-driven provider/model choice for
  // ad-hoc chats wins over the bot's binding.
  if (currentProviderConfig?.model) return currentProviderConfig;

  const readAgents = deps.readConfigAgents ?? readConfigAgents;
  // Default provider resolution goes through the dbRequest IPC bridge (main
  // process) — see `resolveProviderViaDbRequest`. The agent server runs as a
  // raw Node.js child process where Electron's `app` module is unavailable, so
  // importing `provider-store-electron` (→ `db/connection` → `require('electron')`)
  // would crash the server on startup. Tests inject their own resolver.
  const defaultResolveProvider: NonNullable<BotProviderConfigFallbackDeps['resolveBotOrDefaultProvider']> =
    async (bot, fallbackModel) => {
      const provider = await resolveProviderViaDbRequest(deps.dbRequest, bot?.provider);
      if (!provider) throw new Error('no active provider configured');
      const explicit = `${bot?.model ?? ''}${fallbackModel ?? ''}`.trim();
      const model = resolveCronModel(explicit, provider);
      if (!model) throw new Error('cron model is not configured');
      return { provider, model };
    };
  const resolveProvider = deps.resolveBotOrDefaultProvider ?? defaultResolveProvider;
  const buildFallback = deps.buildCronProviderConfig ?? buildCronProviderConfig;

  let agents: Awaited<ReturnType<typeof readAgents>>;
  try {
    agents = await readAgents();
  } catch {
    return currentProviderConfig;
  }
  const botBinding = agents[botAgentId];

  let resolved: { provider: ApiProvider; model: string };
  try {
    resolved = await resolveProvider(
      botBinding ? { provider: botBinding.provider, model: botBinding.model } : undefined,
    );
  } catch {
    return currentProviderConfig;
  }
  const fallback = buildFallback(resolved);

  return {
    ...fallback,
    ...(currentProviderConfig ?? {}),
    // Mirror field-by-field so an empty-string body field can never win
    // against a resolved fallback (e.g. `providerConfig.model = ''`).
    model: currentProviderConfig?.model || fallback.model,
    provider: currentProviderConfig?.provider || fallback.provider,
    apiKey: currentProviderConfig?.apiKey || fallback.apiKey,
    baseURL: currentProviderConfig?.baseURL || fallback.baseURL,
  };
}

/**
 * Resolve a provider through the main-process dbRequest IPC bridge, mirroring
 * the compact lazy-spawn path (`config:provider:get` then
 * `config:provider:getActive`). Electron-free: the agent server is a plain
 * Node child process and must never `require('electron')`.
 */
async function resolveProviderViaDbRequest(
  dbRequest: ((action: string, payload: Record<string, unknown>) => Promise<unknown>) | undefined,
  providerId: string | undefined,
): Promise<ApiProvider | undefined> {
  if (!dbRequest) return undefined;
  let provider: ApiProvider | undefined;
  if (providerId) {
    try {
      provider = await dbRequest('config:provider:get', { id: providerId }) as ApiProvider | undefined;
    } catch {
      // fall through to the active provider
    }
  }
  if (!provider) {
    try {
      provider = await dbRequest('config:provider:getActive', {}) as ApiProvider | undefined;
    } catch {
      // no provider available
    }
  }
  return provider && typeof provider === 'object' ? provider : undefined;
}

/**
 * Resolve the `ProviderRuntimeConfig` for a provider/model pair through the
 * main-process dbRequest IPC bridge (action `config:provider:resolveRuntime`).
 *
 * The main process merges every capability layer (config.toml
 * `[options].model_context`, the `provider_model_capabilities` DB override
 * rows, and the built-in `@duya/ai` catalog) via
 * `ProviderStore.resolveRuntimeCapability` and builds the config with
 * `toRuntimeConfig` — the same construction `agent-communicator.ts` uses for
 * the `agent:getProviderConfig` IPC path.
 *
 * The agent server runs as a plain Node child process and must never touch
 * Electron or the provider store directly, hence the IPC round-trip.
 * Best-effort by design: any failure resolves `undefined` so the caller sends
 * the init message unchanged and the worker falls back to its 200k default
 * compaction budget (with the existing WARN in app.log).
 */
export async function resolveRuntimeConfigViaDbRequest(
  dbRequest: ((action: string, payload: Record<string, unknown>) => Promise<unknown>) | undefined,
  input: { providerId?: string; model?: string },
): Promise<Record<string, unknown> | undefined> {
  if (!dbRequest) return undefined;
  try {
    const result = await dbRequest('config:provider:resolveRuntime', {
      providerId: input.providerId ?? '',
      model: input.model ?? '',
    });
    return result && typeof result === 'object'
      ? (result as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the multi-path project roots for a session's working directory
 * (Plan 525, codex workspace_roots semantics): the session's cwd stays the
 * PRIMARY root; every other `projects.paths` entry of the owning project
 * entity comes back as an additional root.
 *
 * Main side is best-effort (memory DB may be unbootstrapped / no matching
 * project) — on any miss the session behaves exactly as before.
 */
export async function resolveProjectAdditionalRootsViaDbRequest(
  dbRequest: ((action: string, payload: Record<string, unknown>) => Promise<unknown>) | undefined,
  workingDirectory: string | undefined,
): Promise<string[]> {
  if (!dbRequest || !workingDirectory) return [];
  try {
    const result = await dbRequest('projects:resolveAdditionalRoots', {
      workingDirectory,
    }) as { projectId?: unknown; additionalRoots?: unknown } | null;
    if (!result || !Array.isArray(result.additionalRoots)) return [];
    return result.additionalRoots.filter((r): r is string => typeof r === 'string').slice(0, 32);
  } catch {
    return [];
  }
}

/**
 * Plan 536 L4: lightweight cwd -> projectId reverse-lookup, used by the
 * session-bootstrap injection (L1) and any CLI / runtime caller that
 * only needs to know "which project is this cwd in?". Mirrors
 * `resolveProjectAdditionalRootsViaDbRequest` (which keeps the
 * writable-roots fan-out) but consumes the `projects:resolveProject`
 * IPC channel that returns `{ projectId, paths }`.
 *
 * Best-effort: returns `null` for any miss (no dbRequest, no cwd, IPC
 * error, or malformed payload) so callers can treat `null` as
 * "session is not bound to a duya project" without try/catching.
 */
export async function resolveProjectViaDbRequest(
  dbRequest: ((action: string, payload: Record<string, unknown>) => Promise<unknown>) | undefined,
  workingDirectory: string | undefined,
): Promise<{ projectId: string; paths: string[] } | null> {
  if (!dbRequest || !workingDirectory) return null;
  try {
    const result = await dbRequest('projects:resolveProject', {
      workingDirectory,
    }) as { projectId?: unknown; paths?: unknown } | null;
    if (!result || typeof result.projectId !== 'string') return null;
    if (!Array.isArray(result.paths)) return null;
    const paths = result.paths.filter((p): p is string => typeof p === 'string');
    return { projectId: result.projectId, paths };
  } catch {
    return null;
  }
}

/**
 * Merge additional workspace roots into a permissionRules blob's
 * `permissions.additionalDirectories` (dedup, case-insensitive on Windows
 * style paths is left to the worker's own path.resolve — here exact-string
 * dedupe is enough since roots come from one source of truth).
 *
 * L2 hardening (Plan 525): every input root is normalized through
 * `normalizePath` before merging. The dedupe key is the lowercased
 * normalized form so symlink / `..` / case variants of an already-
 * trusted directory collapse onto a single entry. A root whose
 * normalization throws (e.g. NUL byte) is dropped with a WARN so
 * the worker never sees a string that bypassed the boundary.
 */
export function mergeAdditionalRootsIntoPermissionRules(
  permissionRules: unknown,
  additionalRoots: string[],
): unknown {
  if (additionalRoots.length === 0) return permissionRules;
  const base = permissionRules && typeof permissionRules === 'object' ? permissionRules as Record<string, unknown> : {};
  const permissions = base.permissions && typeof base.permissions === 'object' ? base.permissions as Record<string, unknown> : {};
  const existing = Array.isArray(permissions.additionalDirectories)
    ? permissions.additionalDirectories.filter((d): d is string => typeof d === 'string')
    : [];
  // Normalize every existing entry too, so the merged output is in
  // canonical form (matches what we push for the incoming roots).
  // The dedupe key is the lowercased normalized form.
  const merged: string[] = [];
  const seenLower = new Set<string>();
  for (const entry of existing) {
    const normalized = safeNormalize(entry);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seenLower.has(key)) continue;
    seenLower.add(key);
    merged.push(normalized);
  }
  for (const root of additionalRoots) {
    if (typeof root !== 'string' || root.length === 0) continue;
    const normalized = safeNormalize(root);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seenLower.has(key)) continue;
    seenLower.add(key);
    merged.push(normalized);
  }
  return {
    ...base,
    permissions: {
      ...permissions,
      additionalDirectories: merged,
    },
  };
}

/**
 * Normalize a path through `pathUtils.normalizePath` and return its
 * canonical form, or null when the input cannot be safely normalized.
 *
 * Wrapped to swallow `path.resolve` / `realpathSync` failures so the
 * worker permission merge never throws mid-handshake.
 */
function safeNormalize(value: string): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return normalizePath(value).absolute_normalized_path;
  } catch {
    return null;
  }
}

export interface BotProviderConfigFallbackDeps {
  readConfigAgents?: typeof readConfigAgents;
  resolveBotOrDefaultProvider?: (
    bot: { provider?: string; model?: string } | undefined,
    fallbackModel?: string,
  ) => { provider: ApiProvider; model: string } | Promise<{ provider: ApiProvider; model: string }>;
  buildCronProviderConfig?: typeof buildCronProviderConfig;
  /** IPC bridge to the main process, used by the default provider resolver. */
  dbRequest?: (action: string, payload: Record<string, unknown>) => Promise<unknown>;
}

export interface RouterDeps {
  sessionManager: SessionManager;
  workerManager: WorkerManager;
  checkpointBatcher: CheckpointBatcher;
  logger: Logger;
  httpLogger: Logger;
  sessionLogger: Logger;
  dbRequest: (action: string, payload: Record<string, unknown>) => Promise<unknown>;
}

export function sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
  if (res.headersSent) return;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

export function sendNotImplemented(res: http.ServerResponse): void {
  sendJson(res, 501, { error: 'Not Implemented' });
}

export function parsePath(url: string): { pathname: string; parts: string[] } {
  const pathname = url.split('?')[0] || '/';
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  return { pathname, parts };
}

/**
 * Normalize a worker event (a JSON line parsed from the worker's stdout) into
 * the SSE-serializable `{ type, data }` contract consumed by every agent-server
 * client. Both the renderer's POST chat (`handlePostChatSSE`) and its GET
 * reconnect/attach (`handleGetChat`) MUST emit this identical shape; the
 * renderer's `AgentServerClient` reads text via `event.data.content`, so a raw
 * worker frame like `{ type: 'chat:text', data: 'hello' }` would silently drop
 * the payload (empty `data.content`), which manifests as a run view that spins
 * in "loading" with no message stream. Returns `null` for internal
 * control-plane events (`pong`, `memory:wakeup`) that must never reach SSE.
 */
function normalizeWorkerEvent(event: Record<string, unknown>): Record<string, unknown> | null {
  const msgType = event.type as string;
  // Internal heartbeat — never forwarded to SSE clients.
  if (msgType === 'pong') return null;
  // Plan 305 Phase B: `memory:wakeup` is only a control-plane trigger (the
  // POST handler runs MemoryWorker.forceSweep()); the GET (attach) handler
  // must not re-trigger the sweep, so skip it there too.
  if (msgType === 'memory:wakeup') return null;

  let sseEvent: Record<string, unknown> = event;

  if (msgType === 'chat:text' || msgType === 'chat:thinking') {
    sseEvent = {
      type: msgType.replace('chat:', ''), // 'text' or 'thinking'
      data: { content: event.data || event.content },
    };
  } else if (msgType === 'chat:tool_use_started') {
    sseEvent = {
      type: 'tool_use_started',
      data: { id: event.id, name: event.name, input: event.input },
    };
  } else if (msgType === 'chat:tool_use_delta') {
    // Plan 461: incremental tool-call argument fragment. Forwarded verbatim
    // (id/name/delta) so the renderer can render partial file content while
    // the model is still producing the arguments.
    sseEvent = {
      type: 'tool_use_delta',
      data: { id: event.id, name: event.name, delta: event.delta },
    };
  } else if (msgType === 'chat:tool_use') {
    sseEvent = {
      type: 'tool_use',
      data: { id: event.id, name: event.name, input: event.input },
    };
  } else if (msgType === 'chat:tool_result') {
    sseEvent = {
      type: 'tool_result',
      data: { id: event.id, result: event.result, error: event.error, duration_ms: event.duration_ms, metadata: event.metadata },
    };
  } else if (msgType === 'chat:tool_progress') {
    sseEvent = {
      type: 'tool_progress',
      data: event,
    };
  } else if (msgType === 'chat:permission') {
    sseEvent = {
      type: 'permission',
      data: event.request,
    };
  } else if (msgType === 'chat:token_usage') {
    sseEvent = {
      type: 'token_usage',
      data: event,
    };
  } else if (msgType === 'chat:status') {
    sseEvent = {
      type: 'status',
      data: { message: event.status || event.message },
    };
    } else if (msgType === 'compact:start' || msgType === 'compact:done' || msgType === 'compact:error') {
    // Forward compact lifecycle events from DuyaAgent's auto-compaction so the
    // renderer can show a compressing indicator.
    sseEvent = { type: msgType, data: event };
  } else if (msgType === 'chat:mode_changed') {
    // Plan 224 follow-up: agent runtime mode switched (EnterPlanMode /
    // ExitPlanMode / SwitchMode tool). Forward mode + source so the renderer
    // can sync input-box chip/glow.
    sseEvent = {
      type: 'mode_changed',
      data: { mode: event.mode, source: event.source, reason: event.reason },
    };
  } else if (msgType === 'chat:goal_updated') {
    // Plan 411: goal tracker state changed. Forward the flat payload (already
    // carries objective/state/tokens at the top level); drop the `type` field.
    const { type: _t, ...rest } = event;
    sseEvent = { type: 'goal_updated', data: rest };
  } else if (msgType === 'chat:agent_progress') {
    sseEvent = {
      type: msgType.replace('chat:', ''),
      data: event,
    };
  } else if (msgType === 'chat:research_continue') {
    const { type: _t, ...rest } = event;
    sseEvent = { type: 'research_continue', data: rest };
  } else if (msgType === 'chat:research_evidence') {
    const { type: _t, ...rest } = event;
    sseEvent = { type: 'research_evidence', data: rest };
  } else if (msgType === 'chat:research_report') {
    const { type: _t, ...rest } = event;
    sseEvent = { type: 'research_report', data: rest };
  } else if (msgType.startsWith('chat:research_')) {
    // Worker emits `chat:research_*` where convertSSEToAgentMessage spreads the
    // inner `data` object onto the top level (no nested `data` key). Re-wrap so
    // the renderer sees `{ type, data: { from, to, ... } }` like every other
    // chat:* path.
    const { type: _t, ...rest } = event;
    sseEvent = { type: msgType.replace('chat:', ''), data: rest };
  } else if (msgType === 'chat:done') {
    sseEvent = { type: 'done', data: event };
  } else if (msgType === 'chat:error') {
    // Normalize to { type: 'error', data: { message, code? } } so the renderer
    // dispatches through the same `case 'error'` path and can show tailored
    // banners for provider error codes (rate_limit_error, usage_limit_exceeded).
    sseEvent = {
      type: 'error',
      data: { message: event.message || 'Unknown error', code: event.code },
    };
  } else if (msgType === 'chat:retry') {
    // Plan 462: LLM transport is retrying after a transient failure. Forward
    // attempt/maxAttempts + the provider's own wording so the renderer can show
    // e.g. "余额不足，请充值。（重新连接 1/10）".
    sseEvent = {
      type: 'retry',
      data: {
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        message: event.message,
        errorType: event.errorType,
        statusCode: event.statusCode,
      },
    };
  } else if (msgType === 'chat:connector_auth_required') {
    // Plan 450: re-authorization elicitation. Forwarded to the renderer
    // as a discrete event so the AuthRequiredCard can surface a button
    // without polluting the chat error stream. The rest of the event
    // payload (provider, connectionId, toolName, variant) is passed
    // through as `data` so the renderer doesn't need to reach into the
    // wire shape. Plan 503: variant distinguishes the bot-initiated
    // first-time connect ('connect') from the mid-call re-auth ('reauth').
    sseEvent = {
      type: 'connector_auth_required',
      data: {
        provider: (event as { provider?: string }).provider,
        connectionId: (event as { connectionId?: string }).connectionId,
        toolName: (event as { toolName?: string }).toolName,
        variant: (event as { variant?: string }).variant ?? 'reauth',
      },
    };
  } else if (msgType === 'chat:db_persisted') {
    sseEvent = { type: 'db_persisted', data: event };
  } else if (msgType === 'chat:title_generated') {
    sseEvent = { type: 'title_generated', data: event };
  } else if (msgType === 'mcp:reloaded') {
    // Phase 2A diagnostic chain: post-apply summary. Pass through as-is so the
    // renderer / settings UI can consume the activeServerKeys + counts.
    sseEvent = { type: 'mcp:reloaded', data: event };
  } else if (msgType === 'mcp:status:snapshot') {
    // Phase 3: cache the per-server runtime status so the capability
    // aggregator (`buildCrossSourceMCPCapabilities`) can populate
    // `connectionStatus` and `tools[]` from live data instead of the
    // last-apply issue list. The SSE event still ships to the
    // renderer unchanged.
    // Fire-and-forget: normalizeWorkerEvent is synchronous (called from
    // sync onData handlers on the SSE forward path), so a dynamic import
    // cannot be awaited here. Cache the snapshot but never let an ingest
    // failure break the SSE stream.
    void import('../../services/capability-management/mcp-runtime-store.js')
      .then((mod) => mod.setLastMCpStatusSnapshot(event))
      .catch((err) => {
        // Defensive: never break the SSE forward path on a bad payload.
        console.warn('[agents/router] mcp-runtime-store ingest failed:', err);
      });
    sseEvent = { type: 'mcp:status:snapshot', data: event };
  } else if (msgType === 'mcp:reload:error') {
    sseEvent = { type: 'mcp:reload:error', data: event };
  }

  return sseEvent;
}

/**
 * Read the request body as a UTF-8 string. Caps at 64 KiB to
 * match the existing inline parsers in this file; oversize
 * requests get 413 and the connection is destroyed. Returns
 * `null` if the body is empty (no `data` event ever fired).
 */
function readRequestBody(req: import('http').IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let body = '';
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 64 * 1024) {
        settled = true;
        // We can't send the 413 from here (caller still owns the
        // response), but the body is now oversize. The caller
        // should validate length itself; we resolve with the
        // oversized string and the caller's JSON.parse will
        // reject malformed payloads.
      }
    });
    req.on('end', () => finish(body || null));
    req.on('error', () => finish(null));
  });
}

async function handlePostChat(
  sessionId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: RouterDeps,
  workerDbRequests: Map<string, ChildProcess>,
): Promise<void> {
  const { sessionManager, workerManager, checkpointBatcher, logger, httpLogger, sessionLogger, dbRequest } = deps;

  
  let session = sessionManager.getSession(sessionId);

  if (!session) {
    sessionManager.createSession(sessionId);
    session = sessionManager.getSession(sessionId)!;
  }

  // Allow CRASHED and ERROR sessions to recover on new chat
  if (session.state === SessionState.CRASHED || session.state === SessionState.ERROR) {
    httpLogger.info('Resetting session state for new chat', { sessionId, from: session.state });
    try {
      sessionManager.transitionState(sessionId, SessionState.IDLE);
    } catch {
      // State transition may already have been handled
    }
  }

  // M4: Use transitionState(STREAMING) as a concurrency lock. If this throws,
  // another concurrent request already claimed the session — return 409.
  try {
    sessionManager.transitionState(sessionId, SessionState.STREAMING);
  } catch (err) {
    httpLogger.warn('Session busy, rejecting chat', {
      sessionId,
      state: session.state,
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 409, { error: `Session is busy: ${session.state}`.trim() });
    return;
  }

  // 50MB default limit for chat payloads (supports file attachments with base64 data)
  const MAX_CHAT_PAYLOAD_SIZE = parseInt(process.env.DUYA_MAX_CHAT_PAYLOAD_SIZE || '52428800', 10);

  // M4: Helper to release the STREAMING lock on early-return error paths.
  // After M4, the session is in STREAMING state before the request body is
  // read. If any check rejects the request, we must revert to IDLE so the
  // session is not permanently stuck. Also mirrors the release into
  // session_runtime_locks (Plan 476 P0-A) so main can observe idleness.
  const revertStreamingLock = (): void => {
    try {
      const s = sessionManager.getSession(sessionId);
      if (s && s.state === SessionState.STREAMING) {
        sessionManager.transitionState(sessionId, SessionState.IDLE);
      }
    } catch {
      // State may have already changed; ignore
    }
    void releaseChatLock(dbRequest, sessionId).catch(() => {});
  };

  // Plan 476 P0-A: belt-and-braces — release the runtime lock when the
  // HTTP response fully closes (covers the Non-SSE path and any terminal
  // path not routed through revertStreamingLock or the SSE close handler).
  // releaseChatLock is idempotent, so double-release is harmless; the TTL
  // is the final backstop for a process that dies mid-run.
  res.on('close', () => {
    void releaseChatLock(dbRequest, sessionId).catch(() => {});
  });

  let body = '';
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString();
    if (body.length > MAX_CHAT_PAYLOAD_SIZE) {
      revertStreamingLock();
      sendJson(res, 413, { error: 'Payload too large' });
      req.destroy();
    }
  });

  req.on('end', async () => {
    let parsed: { prompt?: string; options?: Record<string, unknown>; providerConfig?: Record<string, unknown>; workingDirectory?: string; systemPrompt?: string; defaultWorkspaceDirectory?: string };
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      revertStreamingLock();
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    // M7: Use structured logger instead of console.log
    httpLogger.debug('Chat request body parsed', {
      sessionId,
      hasPrompt: !!parsed.prompt,
      optionsKeys: parsed.options ? Object.keys(parsed.options) : [],
      agentProfileId: parsed.options?.agentProfileId,
      mode: parsed.options?.mode,
      conductorMode: parsed.options?.conductorMode,
      conductorCanvasId: parsed.options?.conductorCanvasId,
    });

    const prompt = parsed.prompt || '';
    let providerConfig = parsed.providerConfig;
    const workingDirectory = parsed.workingDirectory;
    const defaultWorkspaceDirectory = parsed.defaultWorkspaceDirectory;

    // Plan 506 — see `resolveBotProviderConfigFallback` above.
    const botAgentIdEarly = parseAgentIdFromBotSession(sessionId);
    if (botAgentIdEarly && (!providerConfig || !providerConfig.model)) {
      const fallback = await resolveBotProviderConfigFallback(
        botAgentIdEarly,
        providerConfig,
        { dbRequest },
      );
      if (fallback && fallback !== providerConfig) {
        httpLogger.info('Applied bot providerConfig fallback', {
          sessionId,
          agentId: botAgentIdEarly,
          model: fallback.model,
        });
      }
      parsed.providerConfig = fallback;
    }
    // Plan 506 follow-up: the fallback above mutates `parsed.providerConfig`,
    // but the init send below captured the pre-fallback value. Re-read it so
    // bot sessions without a model in the request body actually receive the
    // resolved binding instead of being rejected by the guard below.
    providerConfig = parsed.providerConfig;

    try {
      // Validate session exists in DB before proceeding (normal sessions).
      // Without a session row, message persistence would fail with FOREIGN KEY
      // constraint errors. Wakeless (orb) sessions are explicitly ephemeral:
      // the worker disables journal + message persistence
      // (`agent.journal = undefined`), and every other DB write it still
      // attempts (hook rows, turn review, compaction) is best-effort and
      // wrapped in try/catch, so a missing row is harmless. Requiring — or
      // auto-creating — a row here would both reject the orb's synthetic
      // `wakeless-*` session *and* pollute the user's session list with
      // throwaway rows. So we skip the check for wakeless turns.
      const isWakeless = parsed.options?.wakeless === true;

      // Plan 477 P3.1 / 491 P1.2 — bot-direct send pipeline. A bot's
      // persistent session (`bot:<agentId>`, 2-part id per the landed 477
      // binding convention) has NO row until its first wake / chat: the
      // renderer opens a placeholder thread and never runs createThread, so
      // the legacy session:get check 404s here. Lazily materialize the row
      // (same canonical shape as agent-dm-dispatcher's wake-created rows,
      // idempotent get-or-create) and force the profile to resolve from the
      // bot binding — the chat path must not depend on request-carried
      // agentProfileId for bot sessions (plan 477 audit point 3).
      const botAgentId = parseAgentIdFromBotSession(sessionId);
      if (botAgentId && !isWakeless) {
        const ensured = (await deps.dbRequest('session:ensureBot', {
          sessionId,
        })) as { ok?: boolean; reason?: string } | undefined;
        if (!ensured?.ok) {
          httpLogger.warn('Chat rejected: bot session could not be ensured', {
            sessionId,
            reason: ensured?.reason,
          });
          revertStreamingLock();
          sendJson(res, 404, {
            error: `Bot session not available: ${sessionId}`,
          });
          return;
        }
        parsed.options = {
          ...(parsed.options ?? {}),
          agentProfileId: botAgentId,
          // Plan 498: bot sessions pause on permission ask — the request is
          // persisted as a durable approval card and the turn ends with a
          // neutral tool result; the decision resumes the run later.
          permissionSurface: 'bot',
        };
      }

      if (!isWakeless) {
        const dbSession = await deps.dbRequest('session:get', { id: sessionId });
        if (!dbSession) {
          httpLogger.warn('Chat rejected: session not found in DB', { sessionId });
          revertStreamingLock();
          sendJson(res, 404, { error: `Session not found: ${sessionId}` });
          return;
        }
      }

      const totalMem = os.totalmem();
      const availableMem = getAvailableMemory();
      const usedRatio = (totalMem - availableMem) / totalMem;

      const MEMORY_THRESHOLD = getWorkerMemoryThreshold();
      if (usedRatio > MEMORY_THRESHOLD) {
        logger.warn('System memory usage high, rejecting chat', { usedRatio, totalMem, availableMem, sessionId });
        revertStreamingLock();
        res.writeHead(503, 'Service Unavailable', {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Retry-After': '30',
        });
        res.end(JSON.stringify({ error: 'System memory usage is high' }));
        return;
      }

      // Plan 426 Phase 1.1: adaptive cap (CPU/2 bounded by total-memory tier)
      const MAX_CONCURRENT_WORKERS = calculateMaxConcurrentWorkers();
      if (workerManager.workerCount >= MAX_CONCURRENT_WORKERS) {
        logger.warn('Max concurrent workers reached, rejecting chat', { current: workerManager.workerCount, max: MAX_CONCURRENT_WORKERS, sessionId });
        revertStreamingLock();
        res.writeHead(503, 'Service Unavailable', {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Retry-After': '10',
        });
        res.end(JSON.stringify({ error: 'Maximum concurrent agents reached' }));
        return;
      }

      // Reuse existing worker for this session if alive — avoids re-fork cost
      // (200-800ms) on consecutive chats within the same session. spawnWorker
      // is only called for the first chat or when the previous worker has exited.
      // exitCode === null means the process is still running; killed indicates
      // kill() was already invoked. Listeners (stdout/message/error/exit) are
      // registered only on first spawn — reusing a worker keeps the persistent
      // listeners from worker-manager.ts and the per-request listeners below
      // attached to the original child, so they must not be re-registered.
      let child: ChildProcess;
      const existingChild = workerManager.getWorker(sessionId);
      if (existingChild && existingChild.exitCode === null && !existingChild.killed) {
        httpLogger.info('Reusing existing worker for session', { sessionId, pid: existingChild.pid });
        child = existingChild;
      } else {
        child = workerManager.spawnWorker(sessionId);
        const workerPid = child.pid;
        // M7: Use structured logger
        httpLogger.info('Worker spawned', { sessionId, pid: workerPid });

        // Log ALL worker stdout for debugging - capture everything
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (data: string) => {
          // M7: Route worker stdout to debug logger instead of console
          httpLogger.debug('Worker stdout', { sessionId, preview: data.toString().substring(0, 300) });
        });

        child.on('message', (msg: Record<string, unknown>) => {
          if (msg.type === 'db:request' && typeof msg.id === 'string' && process.send) {
            workerDbRequests.set(msg.id, child);
            process.send(msg);
            return;
          }
          if (msg.type === 'conductor:executor:rpc' && typeof msg.requestId === 'string' && process.send) {
            workerDbRequests.set(`rpc:${msg.requestId}`, child);
            process.send(msg);
            return;
          }
          // Plan 312: forward appConnection:invoke to the main process
          // (ConnectorService lives in the Electron main process).
          if (msg.type === 'appConnection:invoke' && typeof msg.requestId === 'string' && process.send) {
            workerDbRequests.set(`rpc:${msg.requestId}`, child);
            process.send(msg);
            return;
          }
          // Plan 312: forward appConnection:listDescriptors to the main process.
          if (msg.type === 'appConnection:listDescriptors' && typeof msg.requestId === 'string' && process.send) {
            workerDbRequests.set(`rpc:${msg.requestId}`, child);
            process.send(msg);
          }
          // Plan 503: forward appConnection:catalog to the main process
          // (bot-only connector-management tools).
          if (msg.type === 'appConnection:catalog' && typeof msg.requestId === 'string' && process.send) {
            workerDbRequests.set(`rpc:${msg.requestId}`, child);
            process.send(msg);
          }
          // Plan 454: forward computer-use:execute to the main process.
          if (msg.type === 'computer-use:execute' && typeof msg.requestId === 'string' && process.send) {
            workerDbRequests.set(`rpc:${msg.requestId}`, child);
            process.send(msg);
          }
          // Plan 481: forward memory-tier:rpc to the main process
          // (memory tier writer lives in Electron main).
          if (msg.type === 'memory-tier:rpc' && typeof msg.requestId === 'string' && process.send) {
            workerDbRequests.set(`rpc:${msg.requestId}`, child);
            process.send(msg);
          }
          // Plan 481 amendment: forward bot-identity:rpc to the main process
          // (profile.json writer lives in Electron main). Without this the
          // worker's identity subactions time out after 15s.
          if (msg.type === 'bot-identity:rpc' && typeof msg.requestId === 'string' && process.send) {
            workerDbRequests.set(`rpc:${msg.requestId}`, child);
            process.send(msg);
          }
        });


        child.on('error', (err) => {
          logger.error('Worker spawn error', err, { sessionId });
          if (!res.headersSent) {
            // M4: Release the STREAMING lock before sending the error response.
            // Once SSE takes over (headersSent), the SSE handler manages state.
            revertStreamingLock();
            sendJson(res, 500, { error: 'Failed to spawn worker' });
          }
        });

        child.on('exit', (code, signal) => {
          const session = sessionManager.getSession(sessionId);
          if (session?.state === SessionState.COMPLETED) {
            return;
          }
          if (code === 0) {
            try {
              sessionManager.transitionState(sessionId, SessionState.COMPLETED);
            } catch {
              // state transition may be invalid
            }
          } else {
            sessionManager.setExitInfo(sessionId, code || 0, signal || undefined);
          }
        });
      }

      // Plan 477 P3.1: a bot's persistent session is expected to receive
      // repeated wake / user chats, so its worker is exempted from idle
      // reaping (worker-limits honors keepAlive, same as background-task
      // workers). Idempotent — a no-op when the flag is already set.
      if (botAgentId) {
        workerManager.setKeepAlive(sessionId, true);
      }

      // Reject early if provider config is missing or incomplete so the
      // worker does not crash with a misleading initialization timeout.
      if (!providerConfig || !providerConfig.model) {
        httpLogger.warn('Chat rejected: missing provider config', { sessionId });
        child.kill();
        revertStreamingLock();
        sendJson(res, 400, { error: 'No provider or model configured' });
        return;
      }

      // Attach the server-resolved runtimeConfig when the renderer didn't
      // provide one (legacy renderer, bot fallback, cron bodies). The worker's
      // DuyaAgent reads runtimeConfig.modelCapabilities.contextWindow for the
      // compaction budget — without it every desktop chat compacts at the
      // 200k default even for 1M-window models (see DuyaAgent constructor).
      if (!providerConfig.runtimeConfig) {
        const runtimeConfig = await resolveRuntimeConfigViaDbRequest(dbRequest, {
          providerId: typeof providerConfig.providerId === 'string' ? providerConfig.providerId : undefined,
          model: typeof providerConfig.model === 'string' ? providerConfig.model : undefined,
        });
        if (runtimeConfig) {
          providerConfig = { ...providerConfig, runtimeConfig };
          httpLogger.info('Attached server-resolved runtimeConfig to chat init', {
            sessionId,
            providerId: runtimeConfig.providerId,
            model: runtimeConfig.model,
            contextWindow: (runtimeConfig.modelCapabilities as Record<string, unknown> | undefined)?.contextWindow,
          });
        }
      }

      // Send init first if provider config is provided
      // M7: Use structured logger
      httpLogger.debug('Sending init command to worker', { sessionId, hasProviderConfig: !!providerConfig });
      // Plan 525: the session's cwd is the primary workspace root; every
      // other path of the owning project entity becomes an additional
      // writable root (codex workspace_roots parity). Best-effort.
      const projectAdditionalRoots = await resolveProjectAdditionalRootsViaDbRequest(
        dbRequest,
        workingDirectory || undefined,
      );
      const effectivePermissionRules = mergeAdditionalRootsIntoPermissionRules(
        parsed.options?.permissionRules,
        projectAdditionalRoots,
      );
      // Plan 536 L1: lightweight cwd -> projectId reverse-lookup so the
      // agent subprocess can stamp `currentProjectId` into every
      // ctx.options it builds. Best-effort; null when cwd is outside
      // any registered project. Headless / CLI sessions without a
      // workingDirectory get undefined.
      const resolvedProject = await resolveProjectViaDbRequest(
        dbRequest,
        workingDirectory || undefined,
      );
      workerManager.sendCommand(sessionId, {
        type: 'init',
        sessionId,
        providerConfig,
        workingDirectory: workingDirectory || '',
        defaultWorkspaceDirectory: defaultWorkspaceDirectory || '',
        systemPrompt: parsed.systemPrompt,
        language: 'zh',
        communicationPlatform: parsed.options?.platform,
        securityScanEnabled: parsed.options?.securityScanEnabled,
        referencesEnabled: detectReferencesEnabled(workingDirectory),
        permissionRules: effectivePermissionRules,
        // Plan 536 L1: propagate the resolved projectId so project-
        // scoped tools (plan tool, etc.) can pick it up from the
        // session context instead of forcing the agent to pass it.
        currentProjectId: resolvedProject?.projectId ?? null,
      });

      // Plan 476 P0-A: mirror "this session is running a chat" into
      // session_runtime_locks so the Electron main process can observe
      // busy/idle across the process boundary (agent-server is a fork).
      // Fire-and-forget; the lock carries a TTL and every terminal path
      // (revertStreamingLock + COMPLETED) releases it.
      // Plan 476 P2.5: mark user-initiated turns so main can advance the
      // session turn_epoch (wake/automation requests carry `wakeRun` /
      // `effort: 'off'` / `wakeless` markers — they never advance).
      const isUserTurn = !(
        parsed.options?.wakeRun === true ||
        parsed.options?.effort === 'off' ||
        parsed.options?.wakeless === true
      );
      // Plan 500 P1: persist run attribution on the lock row. Wake dispatches
      // declare their lane via `options.runOrigin`; everything else is a
      // renderer-driven chat (user) or a wakeless background run.
      const runOrigin: ChatLockOrigin =
        parsed.options?.runOrigin === 'user' ||
        parsed.options?.runOrigin === 'agent' ||
        parsed.options?.runOrigin === 'background'
          ? parsed.options.runOrigin
          : isUserTurn
            ? 'user'
            : 'background';
      void acquireChatLock(dbRequest, sessionId, { userTurn: isUserTurn, origin: runOrigin }).catch(() => {});

      const wantsSSE = req.headers.accept?.includes('text/event-stream') ?? false;

      // Open the SSE stream and send chat:start immediately instead of
      // blocking the HTTP response on waitForReady. The worker queues
      // chat:start while it is still initializing, and surfaces init failures
      // through the stream itself (a `ready` error frame, a queued chat:start
      // emitting `chat:error` when the agent is null, or the process-level
      // error/exit handlers in handlePostChatSSE). Removing the gate lets the
      // client connect and show immediate feedback while the worker spins up,
      // which is what makes the start feel responsive (pi-style) rather than a
      // multi-second blank wait.
      try {
        if (wantsSSE) {
          handlePostChatSSE(sessionId, req, res, child, deps);
        } else {
          handlePostChatNonSSE(sessionId, req, res, child, deps);
        }

        workerManager.sendCommand(sessionId, {
          type: 'chat:start',
          sessionId,
          id: randomUUID(),
          prompt,
          options: parsed.options || {},
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        revertStreamingLock();
        sendJson(res, 500, { error: message });
        return;
      }
    } catch (err) {
      // C1: Top-level catch must not swallow errors silently — surface a 500
      // so the client sees something went wrong instead of hanging forever.
      revertStreamingLock();
      if (!res.headersSent) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, 500, { error: message });
      } else {
        httpLogger.error('Unhandled error after headers sent', err instanceof Error ? err : new Error(String(err)), { sessionId });
      }
    }

  }); // close req.on('end')
}

/** SSE 保活间隔：15s，远低于 Node 默认 120s 的套接字空闲超时。 */
const SSE_KEEPALIVE_MS = 15_000;

/**
 * 为一个 SSE 响应启用保活：关闭本次响应的套接字空闲超时，并周期性写入一条
 * SSE 注释行，防止长耗时操作（长思考、上下文压缩）出现 >120s 的静默间隙时
 * 连接被 Node 的 server.timeout 销毁（现象：agent 进程"自动断掉"）。
 *
 * 注释行以 ':' 开头，所有已知消费方都会忽略它，不会被误解析：
 *   - 网关 electron/gateway/message-bus.ts 按 'data: ' 前缀过滤
 *   - 前端 src/lib/agent-sse-client.ts 用 /^(event|id|data):/ 正则
 *   - 前端 src/lib/agent-http-client.ts 用 'data:' / 'event:' 前缀判断
 *
 * @returns 停止保活的函数（req 关闭时也会自动停止）
 */
/**
 * SSE 写入包装器：当渲染端慢（背景标签页、IPC 桥被阻塞）时，未确认的
 * `res.write` 会让 Node 把数据堆在内部的 send 缓冲区里，最终阻塞 socket。
 *
 * 策略：
 * 1. 调用 `sseWrite(res, chunk)` 时若 `res.write()` 返回 false，标记
 *    `backpressured = true`，同时暂停 `child.stdout` 与 keep-alive 写入器
 *    —— 这样 worker 端不会继续产出事件，避免缓冲区无限增长。
 * 2. 在 `res.once('drain', ...)` 恢复时，重置标志、resume `child.stdout`、
 *    由调用方在 drain 回调里重新写出未发送的事件。
 *
 * 注意：keep-alive 的写入同样受 backpressure 控制，drain 后只需自然恢复
 * 周期；不需要手动补发注释行（之前丢的就是噪音，丢了无影响）。
 */
function createBackpressureController(
  child: ChildProcess,
  keepAliveStop: () => void,
): {
  isBackpressured: () => boolean;
  pause: () => void;
  resume: () => void;
} {
  let backpressured = false;

  return {
    isBackpressured: () => backpressured,
    pause: () => {
      if (backpressured) return;
      backpressured = true;
      // Pause worker stdout so we stop consuming frames while the renderer
      // catches up. Worker continues to execute and allocate but the read
      // side of the duplex pipe is paused, capping the in-memory buffer
      // around the readable stream's highWaterMark (~16 KiB).
      try {
        child.stdout?.pause();
      } catch {
        // child.stdout may already be closed
      }
      // Halt keep-alive writes while backpressured; they would just queue
      // up against the same bottleneck and we want to free the buffer.
      keepAliveStop();
    },
    resume: () => {
      if (!backpressured) return;
      backpressured = false;
      try {
        child.stdout?.resume();
      } catch {
        // ignore — close handler will tear down the listener
      }
      // Note: caller is responsible for restarting keep-alive if desired.
      // We don't restart it here because the SSE stream is usually on its
      // way to close once drain fires for a heavily backpressured client.
    },
  };
}

/**
 * Drain-aware SSE write. Returns true if the chunk was accepted by the
 * socket; false if backpressure was applied. The caller MUST track the
 * returned false and resume processing once `res.once('drain')` fires.
 */
function sseWrite(
  res: http.ServerResponse,
  chunk: string,
  bp: { isBackpressured: () => boolean; pause: () => void; resume: () => void },
  reschedule: () => void,
): boolean {
  if (res.writableEnded || res.destroyed) return false;
  const ok = res.write(chunk);
  if (!ok) {
    bp.pause();
    res.once('drain', () => {
      bp.resume();
      reschedule();
    });
    return false;
  }
  return true;
}

function startSSEKeepAlive(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): () => void {
  // 兜底：即使外层 server.timeout 被改回非零值，本次响应也不受空闲超时影响
  res.setTimeout(0);

  let stopped = false;
  const stop = (): void => {
    stopped = true;
    clearInterval(timer);
  };

  const timer = setInterval(() => {
    if (stopped || res.writableEnded || res.destroyed) {
      stop();
      return;
    }
    // Skip writes while the socket is backpressured — they would just queue
    // against the same bottleneck. Drain handler will not restart this
    // timer (the live SSE path usually closes soon after drain), but a
    // future reschedule() from sseWrite() will re-arm a fresh timer.
    try {
      res.write(': keep-alive\n\n');
    } catch {
      stop();
    }
  }, SSE_KEEPALIVE_MS);

  req.on('close', stop);
  return stop;
}

function handlePostChatSSE(
  sessionId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  child: ChildProcess,
  deps: RouterDeps,
): void {
  const { sessionManager, workerManager, checkpointBatcher, logger, httpLogger, dbRequest } = deps;


  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });

  // SSE 保活：关闭本次响应的套接字空闲超时，并每 15s 写一条注释行，
  // 防止长思考期间 >120s 的静默间隙导致连接被销毁。
  startSSEKeepAlive(req, res);

  httpLogger.info('SSE stream opened', { sessionId });

  let seqNum = 0;
  let doneReceived = false;
  let buffer = '';
  // M5: multiLineBuffer promoted to outer scope so multi-line JSON fragments
  // spanning multiple 'data' events are accumulated correctly.
  let multiLineBuffer = '';
  // Accumulate checkpoint messages in memory, write to DB only on done/error
  let pendingMessages: unknown[] = [];

  // H8: onData is referenced inside req.on('close') — declared as a let
  // variable so the close handler can remove it. Assigned below.
  let onData: ((data: Buffer) => void) | null = null;

  req.on('close', () => {
    // H8: If the client disconnects before done/error was received, interrupt
    // the worker so it doesn't keep running uselessly, and tear down the
    // stdout listener so we don't write to a dead response.
    if (!doneReceived && !res.writableEnded) {
      httpLogger.info('SSE client disconnected before completion, interrupting worker', { sessionId });
      if (onData && child.stdout) {
        child.stdout.removeListener('data', onData);
      }
      workerManager.interruptWorker(sessionId, 2000, 'sse-client-disconnect');
    }
    // Plan 476 P0-A: release the runtime lock on every terminal path
    // (done, error, or client disconnect all end up closing the request).
    // Idempotent — no-op when this session never acquired the lock.
    void releaseChatLock(dbRequest, sessionId).catch(() => {});
  });

  // Read events from worker stdout (JSON lines via sendEvent)
  onData = (data: Buffer): void => {
    if (doneReceived) return;

    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    // M5: multiLineBuffer is now at outer scope, not re-declared here

    for (const rawLine of lines) {
      let line = rawLine.trim();
      if (!line) continue;

      // If accumulating a multi-line JSON fragment, keep appending
      if (multiLineBuffer) {
        multiLineBuffer += '\n' + rawLine;
        try {
          JSON.parse(multiLineBuffer);
          line = multiLineBuffer;
          multiLineBuffer = '';
        } catch {
          if (multiLineBuffer.length > 100000) {
            multiLineBuffer = '';
          }
          continue;
        }
      }

      // Skip non-JSON lines (console.log, debug output from worker)
      if (!line.startsWith('{')) {
        continue;
      }

      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const msgType = event.type as string;

        // Filter out pong events (internal heartbeat, not for SSE clients)
        if (msgType === 'pong') {
          continue;
        }

        // Plan 305 Phase B: intercept memory:wakeup worker event and
        // trigger MemoryWorker.forceSweep(). NOT forwarded to SSE
        // (internal control-plane event, like pong).
        if (msgType === 'memory:wakeup') {
          try {
            const { getMemoryWorkerHandle } = require('../../memory/memory-worker');
            const handle = getMemoryWorkerHandle();
            if (handle) {
              // fire-and-forget; forceSweep is async but the router must
              // not block the stdout drain loop on extraction.
              void handle.forceSweep();
            }
          } catch {
            // Shadow mode: best-effort. Worker not started or require
            // failed — silently drop the wakeup.
          }
          continue;
        }

        const sseEvent = normalizeWorkerEvent(event);
        // normalizeWorkerEvent only returns null for the already-skipped
        // control-plane events; guard defensively anyway.
        if (!sseEvent) continue;

        const eventType = sseEvent.type || 'unknown';

        if (eventType === 'done') {
          // Flush pending messages to DB before sending done event
          if (pendingMessages.length > 0 && process.send) {
            const flushMsg = {
              type: 'db:request',
              id: `checkpoint-${sessionId}-${Date.now()}`,
              action: 'replaceMessages',
              payload: {
                sessionId,
                messages: pendingMessages,
                generation: 0,
              },
            };
            try {
              process.send(flushMsg);
              pendingMessages = [];
            } catch (err) {
              // H2: process.send can throw if the IPC channel is closed.
              // Keep pendingMessages in memory so a later flush can retry.
              logger.error('Failed to flush pending messages on done', err instanceof Error ? err : new Error(String(err)), {
                sessionId,
                pendingCount: pendingMessages.length,
              });
            }
          }
          checkpointBatcher.flush();
          try {
            const s = sessionManager.getSession(sessionId);
            if (s && s.state === SessionState.STREAMING) {
              sessionManager.transitionState(sessionId, SessionState.COMPLETED);
            }
          } catch {
            // Session may already be in a different state
          }
          seqNum++;
          sessionManager.updateLastEventId(sessionId, seqNum);
          sessionManager.recordEvent(sessionId, 'done', sseEvent, seqNum);
          if (event.data) {
            sessionManager.setDoneData(sessionId, event.data);
          }
          const msgs = event.data && typeof event.data === 'object' ?
            (event.data as Record<string, unknown>).messages : undefined;
          if (msgs) {
            sessionManager.setLastMessages(sessionId, msgs);
          }
          httpLogger.info('Chat flow: done', { sessionId, seqNum });
          res.write(`event: done\nid: ${seqNum}\ndata: ${JSON.stringify(sseEvent)}\n\n`);
          // H7: Don't set doneReceived=true here — title_generated event may
          // still come after done. Title generation is a separate async LLM
          // call in the worker that is not awaited before `chat:done`, so it
          // can legitimately take longer than a few seconds. Give it a
          // configurable window (default 5s — shortened to shrink the
          // window where a missing `event: done` chunk flips a completed
          // turn into the false-positive `Stream ended unexpectedly` banner)
          // before force-closing the SSE connection.
          const titleTimeoutMs = parseInt(
            process.env.DUYA_TITLE_GENERATED_TIMEOUT_MS || '5000',
            10,
          );
          setTimeout(() => {
            if (!doneReceived && !res.writableEnded) {
              httpLogger.warn('SSE: title_generated not received after done, closing', { sessionId, titleTimeoutMs });
              doneReceived = true;
              res.end();
            }
          }, titleTimeoutMs);
          return;
        }

        if (eventType === 'title_generated') {
          // Send title generated event and close SSE connection
          seqNum++;
          sessionManager.updateLastEventId(sessionId, seqNum);
          sessionManager.recordEvent(sessionId, 'title_generated', sseEvent, seqNum);
          res.write(`event: title_generated\nid: ${seqNum}\ndata: ${JSON.stringify(sseEvent)}\n\n`);
          // M7: Use structured logger
          httpLogger.info('Sent title_generated event, closing SSE', { sessionId });
          doneReceived = true;
          res.end();
          return;
        }

        if (eventType === 'checkpoint') {
          // Don't write to DB immediately - accumulate for done event
          // Collect messages from checkpoint data for later bulk write
          if (sseEvent.data && typeof sseEvent.data === 'object') {
            const msgs = (sseEvent.data as Record<string, unknown>).messages;
            if (msgs) {
              pendingMessages.push(...(Array.isArray(msgs) ? msgs : [msgs]));
            }
          }
          seqNum++;
          sessionManager.updateLastEventId(sessionId, seqNum);
          sessionManager.recordEvent(sessionId, 'checkpoint', sseEvent, seqNum);
          if (sseEvent.data && typeof sseEvent.data === 'object') {
            sessionManager.setLastMessages(sessionId,
              (sseEvent.data as Record<string, unknown>).messages || sseEvent.data);
          }
          res.write(`event: checkpoint\nid: ${seqNum}\ndata: ${JSON.stringify(sseEvent)}\n\n`);
          return;
        }

        if (eventType === 'error') {
          // Flush any pending checkpoint messages to DB before error event
          if (pendingMessages.length > 0 && process.send) {
            const flushMsg = {
              type: 'db:request',
              id: `checkpoint-${sessionId}-${Date.now()}`,
              action: 'replaceMessages',
              payload: {
                sessionId,
                messages: pendingMessages,
                generation: 0,
              },
            };
            try {
              process.send(flushMsg);
              pendingMessages = [];
            } catch (err) {
              // H2: process.send can throw if the IPC channel is closed.
              logger.error('Failed to flush pending messages on error', err instanceof Error ? err : new Error(String(err)), {
                sessionId,
                pendingCount: pendingMessages.length,
              });
            }
          }
          checkpointBatcher.flush();
          seqNum++;
          sessionManager.updateLastEventId(sessionId, seqNum);
          sessionManager.recordEvent(sessionId, 'error', sseEvent as unknown, seqNum);
          const errData = sseEvent.data as { message?: string } | undefined;
          sessionManager.failSession(sessionId, errData?.message || 'Unknown error', true);
          httpLogger.error('Chat error from worker', errData?.message ? new Error(errData.message) : undefined, { sessionId });
          res.write(`event: error\nid: ${seqNum}\ndata: ${JSON.stringify(sseEvent)}\n\n`);
          doneReceived = true;
          res.end();
          return;
        }

        // Forward other events (text, thinking, tool_use, tool_result, permission, ready, etc.)
        seqNum++;
        sessionManager.updateLastEventId(sessionId, seqNum);
        sessionManager.recordEvent(sessionId, eventType, sseEvent, seqNum);
        res.write(`event: ${eventType}\nid: ${seqNum}\ndata: ${JSON.stringify(sseEvent)}\n\n`);
      } catch {
        multiLineBuffer = rawLine;
      }
    }
  };

  // onData is assigned above; non-null assertion is safe here.
  child.stdout!.on('data', onData!);

  child.on('error', (err: Error) => {
    sessionManager.failSession(sessionId, err.message, true);
    httpLogger.error('Worker error', err, { sessionId });
    if (!doneReceived && res.writable) {
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', data: { message: err.message } })}\n\n`);
      doneReceived = true;
      res.end();
    }
  });

  child.on('exit', () => {
    if (onData) {
      child.stdout?.removeListener('data', onData);
    }
    if (!doneReceived && res.writable) {
      sessionManager.failSession(sessionId, 'Worker exited before completing the chat', true);
      doneReceived = true;
      res.end();
    }
  });
}

function handlePostChatNonSSE(
  sessionId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  child: ChildProcess,
  deps: RouterDeps,
): void {
  const { httpLogger } = deps;

  httpLogger.info('Non-SSE chat started', { sessionId });
  let allEvents: unknown[] = [];
  let doneReceived = false;
  let nonSseBuffer = '';
  // M5: multiLineBuffer promoted to outer scope
  let multiLineBuffer = '';

  child.stdout!.on('data', (data: Buffer) => {
    if (doneReceived) return;

    nonSseBuffer += data.toString();
    const lines = nonSseBuffer.split('\n');
    nonSseBuffer = lines.pop() || '';

    for (const rawLine of lines) {
      if (doneReceived) return;

      let line = rawLine.trim();
      if (!line) continue;

      if (multiLineBuffer) {
        multiLineBuffer += '\n' + rawLine;
        try {
          JSON.parse(multiLineBuffer);
          line = multiLineBuffer;
          multiLineBuffer = '';
        } catch {
          if (multiLineBuffer.length > 100000) {
            multiLineBuffer = '';
          }
          continue;
        }
      }

      if (!line.startsWith('{')) continue;

      try {
        const event = JSON.parse(line);
        allEvents.push(event);

        if (event.type === 'chat:done' || event.type === 'chat:error') {
          doneReceived = true;
          sendJson(res, 200, { events: allEvents });
          return;
        }
      } catch {
        multiLineBuffer = rawLine;
      }
    }
  });

  req.on('close', () => {
    if (!doneReceived) {
      sendJson(res, 200, { events: allEvents, status: 'interrupted' });
    }
  });
}

function handleDeleteChat(
  sessionId: string,
  res: http.ServerResponse,
  deps: RouterDeps,
): void {
  const { sessionManager, workerManager, httpLogger, dbRequest } = deps;
  httpLogger.info('Chat interruption requested', { sessionId });

  const session = sessionManager.getSession(sessionId);
  if (session) {
    try {
      if (session.state === SessionState.STREAMING || session.state === SessionState.COMPLETING) {
        sessionManager.transitionState(sessionId, SessionState.COMPLETED);
      }
    } catch (err) {
      httpLogger.warn('Failed to mark interrupted chat as completed', {
        sessionId,
        state: session.state,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Plan 476 P0-A: explicit interrupt must also release the runtime lock
  // (the SSE close path may not fire when the client is gone).
  void releaseChatLock(dbRequest, sessionId).catch(() => {});

  const interrupted = workerManager.interruptWorker(sessionId, 2000, 'delete');
  sendJson(res, 200, { ok: true, interrupted });
}

// Live permission-mode switch (desktop composer selector → running worker).
// Forwards `permission:set` to the worker so the running agent re-reads the
// mode on every permission decision without waiting for the next chat:start.
// Fire-and-forget semantics: the worker may be idle (no process) — the DB
// row is the durable fallback for the next chat:start.
const VALID_AGENT_MODES = ['default', 'auto', 'bypassPermissions'] as const;

function handlePostPermissionMode(
  sessionId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: RouterDeps,
): void {
  const { workerManager, httpLogger } = deps;

  let body = '';
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString();
  });

  req.on('end', () => {
    let parsed: { mode?: unknown };
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const mode = parsed.mode;
    if (typeof mode !== 'string' || !(VALID_AGENT_MODES as readonly string[]).includes(mode)) {
      sendJson(res, 400, {
        error: `Invalid mode. Must be one of: ${VALID_AGENT_MODES.join(', ')}`,
      });
      return;
    }

    httpLogger.info('Live permission-mode switch requested', { sessionId, mode });
    const sent = workerManager.sendCommand(sessionId, {
      type: 'permission:set',
      // sessionId is required by the agent process to keep per-session state
      // isolated (same contract as permission:resolve).
      sessionId,
      mode,
    });
    sendJson(res, sent ? 200 : 404, sent ? { ok: true } : { error: 'Worker not available' });
  });
}

function handlePostPermission(
  sessionId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: RouterDeps,
): void {
  const { sessionManager, workerManager, httpLogger } = deps;

  const session = sessionManager.getSession(sessionId);
  if (!session) {
    sendJson(res, 404, { error: 'Session not found' });
    return;
  }

  let body = '';
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString();
  });

  req.on('end', () => {
    let parsed: { id?: string; decision?: string; updatedInput?: Record<string, unknown>; message?: string };
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const { id, decision, updatedInput, message } = parsed;

    if (!id || !decision) {
      sendJson(res, 400, { error: 'Missing required fields: id, decision' });
      return;
    }

    const validDecisions = ['allow', 'deny', 'allow_once', 'allow_for_session'];
    if (!validDecisions.includes(decision)) {
      sendJson(res, 400, { error: `Invalid decision. Must be one of: ${validDecisions.join(', ')}` });
      return;
    }

    httpLogger.info('Permission resolution requested', { sessionId, id, decision });

    const cmd: Record<string, unknown> = {
      type: 'permission:resolve',
      // sessionId is required by the agent process to keep its pendingPermissions
      // map isolated per session (B4). Without it, a sub-agent/fork could
      // accidentally unlock a top-level session's prompt.
      sessionId,
      id,
      decision,
    };
    if (updatedInput) {
      cmd.updatedInput = updatedInput;
    }
    if (message) {
      cmd.message = message;
    }

    const sent = workerManager.sendCommand(sessionId, cmd);
    if (!sent) {
      sendJson(res, 503, { error: 'Worker not available for permission resolution' });
      return;
    }

    sendJson(res, 200, { ok: true });
  });
}

interface ChatInitParams {
  providerConfig: Record<string, unknown> | undefined;
  workingDirectory?: string;
  systemPrompt?: string;
}

/**
 * Build the legacy `InitMessage.providerConfig` shape that the agent
 * worker expects, from the persisted session row + the resolved
 * `ApiProvider`. The legacy `ApiProvider` DTO does NOT carry a `model`
 * field (it lives on `chat_sessions.model`), and it uses `providerType`
 * / `baseUrl` where the worker expects `provider` / `baseURL`. Without
 * this transform the worker crashes with "Model is required" on its
 * first `new duyaAgent({...})` call — see the bug logged from the
 * `compact` lazy-spawn path.
 *
 * Mirrors the construction in `agent-communicator.ts:agent:getProviderConfig`
 * so chat-spawned and compact-spawned workers get equivalent configs.
 */
export function buildInitProviderConfig(
  sessionRow: Record<string, unknown>,
  provider: ApiProvider | undefined,
): Record<string, unknown> | undefined {
  // Resolve the model: session row wins (it's the user's explicit choice
  // for this session), then provider.options.defaultModel/model, then
  // an empty string. We intentionally do NOT call
  // getDefaultModelForProvider() here — that would silently substitute a
  // fallback and the worker would still crash on empty `model` if no
  // provider options exist.
  const opts = (provider?.options ?? undefined) as Record<string, unknown> | undefined;
  const sessionModel = typeof sessionRow.model === 'string' ? sessionRow.model.trim() : '';
  const optModel = typeof opts?.defaultModel === 'string'
    ? (opts.defaultModel as string).trim()
    : typeof opts?.model === 'string'
      ? (opts.model as string).trim()
      : '';
  const model = sessionModel || optModel;

  if (!provider) {
    // No provider in DB and no active provider — still surface the model
    // (if any) so the worker at least has a value to validate against.
    if (!model) return undefined;
    return { model };
  }

  return {
    providerId: provider.id,
    apiKey: typeof provider.apiKey === 'string' ? provider.apiKey : '',
    baseURL: typeof provider.baseUrl === 'string' && provider.baseUrl
      ? provider.baseUrl
      : undefined,
    model,
    // `providerType` (e.g. 'openai-compatible') is the persisted type;
    // `provider` is the LLM-protocol discriminator the agent uses to
    // pick its client factory. The mapping is local-URL-aware (Ollama
    // detection on 11434) so we must pass `baseUrl` through.
    provider: toLLMProvider(provider.providerType, provider.baseUrl),
    authStyle: 'api_key' as const,
  };
}

/**
 * Lazy-spawn a worker for a session that does not have a live worker (e.g.
 * after Agent Server restart, or after a previous chat ended and the worker
 * was torn down). Loads session row + provider config from DB, mirrors the
 * spawn-and-init flow from handlePostChat, and waits for the worker's
 * `ready` signal before returning.
 *
 * The actual command (`compact`, future ones) is sent by the caller after
 * this helper resolves.
 *
 * Returns `{ ok: true }` on success; `{ ok: false, status, error }` and
 * writes the HTTP error to `res` on any failure path.
 */
async function lazySpawnWorkerForCompact(
  sessionId: string,
  deps: RouterDeps,
  workerDbRequests: Map<string, ChildProcess>,
  res: http.ServerResponse,
): Promise<{ ok: true; child: ChildProcess; init: ChatInitParams } | { ok: false }> {
  const { sessionManager, workerManager, logger, httpLogger } = deps;

  // Memory / concurrency guards — same as handlePostChat.
  const totalMem = os.totalmem();
  const availableMem = getAvailableMemory();
  const usedRatio = (totalMem - availableMem) / totalMem;

  const MEMORY_THRESHOLD = getWorkerMemoryThreshold();
  if (usedRatio > MEMORY_THRESHOLD) {
    logger.warn('System memory usage high, rejecting compact lazy-spawn', { usedRatio, totalMem, availableMem, sessionId });
    sendJson(res, 503, { error: 'System memory usage is high', retryAfterSec: 30 });
    return { ok: false };
  }
  const MAX_CONCURRENT_WORKERS = calculateMaxConcurrentWorkers();
  if (workerManager.workerCount >= MAX_CONCURRENT_WORKERS) {
    logger.warn('Max concurrent workers reached, rejecting compact lazy-spawn', {
      current: workerManager.workerCount,
      max: MAX_CONCURRENT_WORKERS,
      sessionId,
    });
    sendJson(res, 503, { error: 'Maximum concurrent agents reached', retryAfterSec: 10 });
    return { ok: false };
  }

  // Load session row + provider config from the DB to build init params.
  // All config access goes through `dbRequest` (IPC → main process) because
  // the agent server runs as a raw Node.js child process where Electron's
  // `app` module is unavailable. Calling `getConfigManager()` directly here
  // would crash on `app.getPath('userData')` → 503.
  let sessionRow: Record<string, unknown> | null = null;
  let providerConfig: Record<string, unknown> | undefined;
  try {
    const rowResult = await deps.dbRequest('session:get', { id: sessionId });
    sessionRow = (rowResult && typeof rowResult === 'object') ? rowResult as Record<string, unknown> : null;
    if (sessionRow) {
      const providerId = typeof sessionRow.provider_id === 'string' ? sessionRow.provider_id : '';
      let apiProvider: ApiProvider | undefined;
      if (providerId && providerId !== 'env') {
        try {
          apiProvider = await deps.dbRequest('config:provider:get', { id: providerId }) as ApiProvider | undefined;
        } catch {
          // fall through to active provider
        }
      }
      if (!apiProvider) {
        try {
          apiProvider = await deps.dbRequest('config:provider:getActive', {}) as ApiProvider | undefined;
        } catch {
          // no provider available; buildInitProviderConfig handles undefined
        }
      }
      providerConfig = buildInitProviderConfig(sessionRow, apiProvider);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Compact lazy-spawn: failed to load session/provider', { sessionId, error: msg });
    sendJson(res, 503, { error: `Failed to load session config: ${msg}` });
    return { ok: false };
  }

  if (!sessionRow) {
    // Session truly does not exist in DB (not just in-memory); this is a 404.
    httpLogger.warn('Compact lazy-spawn: session not in DB', { sessionId });
    sendJson(res, 404, { error: 'Session not found' });
    return { ok: false };
  }

  // Attach the server-resolved runtimeConfig (capability merge) so the
  // compact-spawned worker gets the same compaction budget as a
  // chat-spawned one. Best-effort — see resolveRuntimeConfigViaDbRequest.
  if (providerConfig && !providerConfig.runtimeConfig) {
    const runtimeConfig = await resolveRuntimeConfigViaDbRequest(deps.dbRequest, {
      providerId: typeof providerConfig.providerId === 'string' ? providerConfig.providerId : undefined,
      model: typeof providerConfig.model === 'string' ? providerConfig.model : undefined,
    });
    if (runtimeConfig) providerConfig = { ...providerConfig, runtimeConfig };
  }

  const init: ChatInitParams = {
    providerConfig,
    workingDirectory: typeof sessionRow.working_directory === 'string' ? sessionRow.working_directory : undefined,
    systemPrompt: typeof sessionRow.system_prompt === 'string' ? sessionRow.system_prompt : undefined,
  };

  // Spawn the worker.
  const child = workerManager.spawnWorker(sessionId);
  const workerPid = child.pid;
  httpLogger.info('Compact: lazy-spawned worker', { sessionId, pid: workerPid, hasProviderConfig: !!providerConfig });

  // Wire up stdout logging, db:request routing, error/exit handlers.
  // Mirrors handlePostChat's setup so the worker behaves identically to
  // a chat-spawned one.
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (data: string) => {
    const text = data.toString();
    // M7: Route worker stdout to debug logger instead of console
    httpLogger.debug('Worker stdout (compact-lazy)', { sessionId, preview: text.substring(0, 300) });
  });

  child.on('message', (msg: Record<string, unknown>) => {
    if (msg.type === 'db:request' && typeof msg.id === 'string' && process.send) {
      workerDbRequests.set(msg.id, child);
      process.send(msg);
      return;
    }
    if (msg.type === 'conductor:executor:rpc' && typeof msg.requestId === 'string' && process.send) {
      workerDbRequests.set(`rpc:${msg.requestId}`, child);
      process.send(msg);
      return;
    }
    // Plan 312: forward appConnection:invoke to the main process.
    if (msg.type === 'appConnection:invoke' && typeof msg.requestId === 'string' && process.send) {
      workerDbRequests.set(`rpc:${msg.requestId}`, child);
      process.send(msg);
      return;
    }
    // Plan 312: forward appConnection:listDescriptors to the main process.
    if (msg.type === 'appConnection:listDescriptors' && typeof msg.requestId === 'string' && process.send) {
      workerDbRequests.set(`rpc:${msg.requestId}`, child);
      process.send(msg);
    }
    // Plan 503: forward appConnection:catalog to the main process
    // (bot-only connector-management tools).
    if (msg.type === 'appConnection:catalog' && typeof msg.requestId === 'string' && process.send) {
      workerDbRequests.set(`rpc:${msg.requestId}`, child);
      process.send(msg);
    }
    // Plan 454: forward computer-use:execute to the main process.
    if (msg.type === 'computer-use:execute' && typeof msg.requestId === 'string' && process.send) {
      workerDbRequests.set(`rpc:${msg.requestId}`, child);
      process.send(msg);
    }
    // Plan 481: forward memory-tier:rpc to the main process
    // (memory tier writer lives in Electron main).
    if (msg.type === 'memory-tier:rpc' && typeof msg.requestId === 'string' && process.send) {
      workerDbRequests.set(`rpc:${msg.requestId}`, child);
      process.send(msg);
    }
    // Plan 481 amendment: forward bot-identity:rpc to the main process
    // (profile.json writer lives in Electron main). Without this the
    // worker's identity subactions time out after 15s.
    if (msg.type === 'bot-identity:rpc' && typeof msg.requestId === 'string' && process.send) {
      workerDbRequests.set(`rpc:${msg.requestId}`, child);
      process.send(msg);
    }
  });

  child.on('error', (err) => {
    logger.error('Compact lazy-spawn: worker error', err, { sessionId });
  });

  child.on('exit', (code, signal) => {
    const session = sessionManager.getSession(sessionId);
    if (session?.state === SessionState.COMPLETED) return;
    if (code === 0) {
      try {
        sessionManager.transitionState(sessionId, SessionState.COMPLETED);
      } catch {
        // state transition may be invalid; safe to ignore
      }
    } else {
      sessionManager.setExitInfo(sessionId, code || 0, signal || undefined);
    }
  });

  // Send init.
  workerManager.sendCommand(sessionId, {
    type: 'init',
    sessionId,
    providerConfig: init.providerConfig,
    workingDirectory: init.workingDirectory || '',
    defaultWorkspaceDirectory: '',
    systemPrompt: init.systemPrompt,
    language: 'zh',
    referencesEnabled: detectReferencesEnabled(init.workingDirectory),
  });

  // Plan 508: distinguish `ready { status: 'error' | 'deferred' }` from a
  // normal ready handshake so a failed worker init (e.g. bot session with
  // no provider config) no longer makes the subsequent compact command hit
  // "Agent not initialized" inside the worker.
  const readyResult = await waitForWorkerReady(child, 30000);
  if (readyResult.ok) {
    httpLogger.info('Compact: lazy-spawned worker ready', { sessionId });
    return { ok: true, child, init };
  }
  logger.error(
    'Compact lazy-spawn: worker ready failed',
    new Error(readyResult.message),
    { sessionId, reason: readyResult.reason },
  );
  const status = readyResult.reason === 'timeout' ? 504
    : readyResult.reason === 'error' ? 503
    : 409;
  sendJson(res, status, { error: readyResult.message });
  return { ok: false };
}

/**
 * Plan 508: shared worker-ready handshake helper.
 *
 * The worker signals ready by emitting either `ready` (with optional
 * `status: 'error' | 'deferred'`) or `conductor:ready`. We resolve on the
 * first successful ready, and reject with a structured reason on:
 *  - `status: 'error'`  → surface the worker's `error` message (503 upstream)
 *  - `status: 'deferred'` → init deferred to a later handshake (409 upstream)
 *  - timeout             → no signal within `timeoutMs` (504 upstream)
 *
 * Extracted from `lazySpawnWorkerForCompact` so the contract is unit-testable
 * independently of the full session-store / provider-config path.
 */
export type WorkerReadyOutcome =
  | { ok: true }
  | { ok: false; reason: 'error' | 'deferred' | 'timeout'; message: string };

export function waitForWorkerReady(
  child: ChildProcess,
  timeoutMs: number,
): Promise<WorkerReadyOutcome> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve({ ok: false, reason: 'timeout', message: `Worker ready timeout (${timeoutMs}ms)` });
    }, timeoutMs);
    let readyBuffer = '';
    const readyHandler = (data: Buffer): void => {
      readyBuffer += data.toString();
      const lines = readyBuffer.split('\n');
      readyBuffer = lines.pop() || '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || !line.startsWith('{')) continue;
        try {
          const m = JSON.parse(line) as { type?: string; status?: string; error?: string; reason?: string };
          if (m.type === 'ready' || m.type === 'conductor:ready') {
            clearTimeout(timeout);
            cleanup();
            if (m.status === 'error') {
              resolve({
                ok: false,
                reason: 'error',
                message: m.error ?? 'Worker initialization failed (no error message)',
              });
              return;
            }
            if (m.status === 'deferred') {
              resolve({
                ok: false,
                reason: 'deferred',
                message: m.reason ?? m.error ?? 'Worker init deferred; retry once the session is active',
              });
              return;
            }
            resolve({ ok: true });
            return;
          }
        } catch {
          // Continue scanning
        }
      }
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout?.removeListener('data', readyHandler);
    };
    child.stdout!.on('data', readyHandler);
  });
}

async function handlePostCompact(
  sessionId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: RouterDeps,
  workerDbRequests: Map<string, ChildProcess>,
): Promise<void> {
  const { sessionManager, workerManager, httpLogger } = deps;

  let session = sessionManager.getSession(sessionId);
  if (!session) {
    // Mirror handlePostChat: cold session that has not received a chat turn yet
    // must not block compact — autocreate so downstream checks (worker, state)
    // produce the most specific 4xx error instead of a misleading "Session not found".
    sessionManager.createSession(sessionId);
    session = sessionManager.getSession(sessionId)!;
    httpLogger.info('Compact: autocreated session', { sessionId });
  }

  // M6: Use transitionState(COMPLETING) as a concurrency lock. If this throws,
  // another concurrent request already claimed the session — return 409.
  try {
    sessionManager.transitionState(sessionId, SessionState.COMPLETING);
  } catch (err) {
    httpLogger.warn('Session busy, rejecting compact', {
      sessionId,
      state: session.state,
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 409, { error: `Session is busy: ${session.state}` });
    return;
  }

  // Lazy-spawn a worker if none exists. The session row was either pre-loaded
  // by hydrateSessionsFromDb or autocreated above; in both cases the DB row
  // must exist or the helper returns 404.
  if (!workerManager.hasWorker(sessionId)) {
    httpLogger.info('Compact: no live worker, attempting lazy spawn', { sessionId });
    const result = await lazySpawnWorkerForCompact(sessionId, deps, workerDbRequests, res);
    if (!result.ok) {
      // helper already wrote the error response — revert COMPLETING lock to IDLE
      try {
        sessionManager.transitionState(sessionId, SessionState.IDLE);
      } catch {
        // State may have already changed; ignore
      }
      return;
    }
  }

  httpLogger.info('Compaction requested', { sessionId });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });

  // 上下文压缩是一次长耗时 LLM 调用，同样会出现 >120s 的静默间隙
  startSSEKeepAlive(req, res);

  const child = workerManager.getWorker(sessionId);
  if (!child) {
    // Race: worker died between lazy-spawn and getWorker. Surface a specific
    // error so the client can distinguish this from the no-session case.
    httpLogger.error('Compact: worker missing after lazy-spawn', undefined, { sessionId });
    res.write(`event: compact:error\ndata: ${JSON.stringify({ type: 'compact:error', sessionId, message: 'Worker became unavailable' })}\n\n`);
    res.end();
    // M6: Revert COMPLETING lock to IDLE so the session can accept future requests
    try {
      sessionManager.transitionState(sessionId, SessionState.IDLE);
    } catch {
      // State may have already changed; ignore
    }
    return;
  }

  // Send compact command to worker
  workerManager.sendCommand(sessionId, { type: 'compact', sessionId });

  // Listen for compact events from worker stdout
  let compactDone = false;
  let compactBuffer = '';
  // M5: multiLineBuffer promoted to outer scope
  let multiLineBuffer = '';
  const onData = (data: Buffer): void => {
    if (compactDone) return;

    compactBuffer += data.toString();
    const lines = compactBuffer.split('\n');
    compactBuffer = lines.pop() || '';

    for (const rawLine of lines) {
      if (compactDone) return;

      let line = rawLine.trim();
      if (!line) continue;

      if (multiLineBuffer) {
        multiLineBuffer += '\n' + rawLine;
        try {
          JSON.parse(multiLineBuffer);
          line = multiLineBuffer;
          multiLineBuffer = '';
        } catch {
          if (multiLineBuffer.length > 100000) {
            multiLineBuffer = '';
          }
          continue;
        }
      }

      if (!line.startsWith('{')) continue;

      try {
        const event = JSON.parse(line);
        const eventType = event.type as string;

        if (eventType === 'chat:token_usage') {
          // The worker pushes a fresh post-compaction context snapshot right
          // before compact:done. Forward it on this stream — no chat SSE is
          // attached while the session is idle, so dropping it here left the
          // renderer's ring on the pre-compaction value until the next turn.
          const sseEvent = normalizeWorkerEvent(event);
          if (sseEvent) {
            res.write(`event: ${sseEvent.type}\ndata: ${JSON.stringify(sseEvent)}\n\n`);
          }
          continue;
        }

        if (eventType === 'compact:done') {
          httpLogger.info('Compaction done', { sessionId });
          res.write(`event: compact:done\ndata: ${JSON.stringify(event)}\n\n`);
          compactDone = true;
          res.end();
          child.stdout?.removeListener('data', onData);
          // M6: Release the COMPLETING lock
          try {
            sessionManager.transitionState(sessionId, SessionState.IDLE);
          } catch {
            // State may have already changed
          }
          return;
        }

        if (eventType === 'compact:error') {
          httpLogger.error('Compaction error', new Error(event.message || 'Unknown error'), { sessionId });
          res.write(`event: compact:error\ndata: ${JSON.stringify(event)}\n\n`);
          compactDone = true;
          res.end();
          child.stdout?.removeListener('data', onData);
          // M6: Release the COMPLETING lock
          try {
            sessionManager.transitionState(sessionId, SessionState.IDLE);
          } catch {
            // State may have already changed
          }
          return;
        }
      } catch {
        multiLineBuffer = rawLine;
      }
    }
  };

  child.stdout?.on('data', onData);

  child.on('exit', () => {
    if (!compactDone) {
      httpLogger.warn('Worker exited during compaction', { sessionId });
      res.write(`event: compact:error\ndata: ${JSON.stringify({ type: 'compact:error', sessionId, message: 'Worker exited' })}\n\n`);
      compactDone = true;
      res.end();
      // M6: Release the COMPLETING lock
      try {
        sessionManager.transitionState(sessionId, SessionState.IDLE);
      } catch {
        // State may have already changed
      }
    }
  });

  req.on('close', () => {
    child.stdout?.removeListener('data', onData);
  });
}

function handleGetChat(
  sessionId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: RouterDeps,
): void {
  const { sessionManager, workerManager, httpLogger } = deps;

  const session = sessionManager.getSession(sessionId);
  if (!session) {
    sendJson(res, 404, { error: 'Session not found' });
    return;
  }

  if (session.state !== SessionState.STREAMING) {
    httpLogger.warn('Get chat for non-streaming session', { sessionId, state: session.state });
    sendJson(res, 409, { error: `Session is not streaming: ${session.state}` });
    return;
  }

  const child = workerManager.getWorker(sessionId);
  if (!child) {
    httpLogger.warn('Get chat for missing worker', { sessionId });
    sendJson(res, 404, { error: 'Worker not found' });
    return;
  }

  const lastEventIdHeader = req.headers['last-event-id'];
  const lastEventId = typeof lastEventIdHeader === 'string' ? parseInt(lastEventIdHeader, 10) || 0 : 0;

  httpLogger.info('SSE reconnection', { sessionId, lastEventId, serverLastEventId: session.lastEventId });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });

  // 重连订阅是长连接，同样需要保活
  startSSEKeepAlive(req, res);

  // Replay buffered events the client missed (events with eventId > lastEventId).
  // The event buffer is populated by the main chat path (handlePostChat) via
  // sessionManager.recordEvent(). This covers events that were emitted between
  // the client disconnect and reconnect.
  const missedEvents = sessionManager.getEventsSince(sessionId, lastEventId);
  for (const record of missedEvents) {
    if (record.eventType === 'done') {
      res.write(`event: done\nid: ${record.eventId}\ndata: ${JSON.stringify(record.data)}\n\n`);
      res.end();
      return;
    }
    if (record.eventType === 'error') {
      res.write(`event: error\nid: ${record.eventId}\ndata: ${JSON.stringify(record.data)}\n\n`);
      res.end();
      return;
    }
    res.write(`event: ${record.eventType}\nid: ${record.eventId}\ndata: ${JSON.stringify(record.data)}\n\n`);
  }

  // If replay already delivered a terminal event, stop here.
  const lastMissed = missedEvents[missedEvents.length - 1];
  if (lastMissed && (lastMissed.eventType === 'done' || lastMissed.eventType === 'error')) {
    return;
  }

  // Start the live-stream counter from the server's last known event ID so
  // new events from stdout get IDs that continue the sequence correctly.
  // Previously this was `let seqNum = 0` which caused the `seqNum <= lastEventId`
  // skip check to drop events with wrong IDs — the local counter never matched
  // the global event ID space.
  let seqNum = session.lastEventId;
  let doneReceived = false;
  let reconnectBuffer = '';
  // M5: multiLineBuffer promoted to outer scope
  let multiLineBuffer = '';

  const onData = (data: Buffer) => {
    if (doneReceived) return;

    reconnectBuffer += data.toString();
    const lines = reconnectBuffer.split('\n');
    reconnectBuffer = lines.pop() || '';

    for (const rawLine of lines) {
      if (doneReceived) return;

      let line = rawLine.trim();
      if (!line) continue;

      // If accumulating a multi-line JSON fragment, keep appending
      if (multiLineBuffer) {
        multiLineBuffer += '\n' + rawLine;
        try {
          JSON.parse(multiLineBuffer);
          line = multiLineBuffer;
          multiLineBuffer = '';
        } catch {
          if (multiLineBuffer.length > 100000) {
            multiLineBuffer = '';
          }
          continue;
        }
      }

      if (!line.startsWith('{')) continue;

      try {
        const event = JSON.parse(line);
        const sse = normalizeWorkerEvent(event);
        if (!sse) continue;

        const eventType = sse.type || 'unknown';
        seqNum++;

        if (eventType === 'done') {
          res.write(`event: done\nid: ${seqNum}\ndata: ${JSON.stringify(sse)}\n\n`);
          doneReceived = true;
          res.end();
          child.stdout!.removeListener('data', onData);
          return;
        }

        if (eventType === 'error') {
          // Normalize to { type: 'error', data: { message, code? } } so the
          // renderer dispatches through the same `case 'error'` path used
          // by every other chat:* event, and can show tailored banners for
          // provider error codes (rate_limit_error, usage_limit_exceeded).
          const errData = (sse.data ?? {}) as { message?: string };
          sessionManager.failSession(sessionId, errData.message || 'Unknown error', true);
          res.write(`event: error\nid: ${seqNum}\ndata: ${JSON.stringify(sse)}\n\n`);
          doneReceived = true;
          res.end();
          child.stdout!.removeListener('data', onData);
          return;
        }

        // Forward the SAME normalized contract as handlePostChatSSE. Writing the
        // raw worker frame here (as this block did before) drops the payload on
        // the renderer (its AgentServerClient reads text via event.data.content),
        // which surfaced as a cron run view stuck in "loading" with no stream.
        res.write(`event: ${eventType}\nid: ${seqNum}\ndata: ${JSON.stringify(sse)}\n\n`);
      } catch {
        multiLineBuffer = rawLine;
      }
    }
  };

  child.stdout!.on('data', onData);

  child.on('exit', () => {
    if (!doneReceived && res.writable) {
      sessionManager.failSession(sessionId, 'Worker exited before completing the chat', true);
      doneReceived = true;
      res.end();
    }
    child.stdout!.removeListener('data', onData);
  });

  req.on('close', () => {
    if (!doneReceived) {
      child.stdout!.removeListener('data', onData);
      res.end();
    }
  });
}

function handleGetHistory(
  sessionId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: RouterDeps,
): void {
  const { sessionManager } = deps;

  const session = sessionManager.getSession(sessionId);
  if (!session) {
    sendJson(res, 404, { error: 'Session not found' });
    return;
  }

  const url = req.url || '';
  const queryMatch = url.match(/[?&]since=(\d+)/);
  const sinceEventId = queryMatch ? parseInt(queryMatch[1], 10) : 0;

  const events = sessionManager.getEventsSince(sessionId, sinceEventId);
  sendJson(res, 200, { sessionId, events, sinceEventId });
}

/**
 * Handle a one-shot side question (`/btw`) for a session. The worker snapshots
 * the current conversation, issues a no-tool single LLM call, and returns one
 * text answer. Unlike `chat`, this never mutates the durable transcript — it
 * is a pure side Q&A layered on top of the live agent.
 */
async function handlePostSideQuestion(
  sessionId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: RouterDeps,
  workerDbRequests: Map<string, ChildProcess>,
): Promise<void> {
  const { sessionManager, workerManager, httpLogger } = deps;

  const session = sessionManager.getSession(sessionId);
  if (!session) {
    sendJson(res, 404, { error: `Session not found: ${sessionId}` });
    return;
  }

  const body = await readRequestBody(req);
  let payload: { id?: string; question?: string };
  try {
    payload = body ? JSON.parse(body) : {};
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const question = typeof payload.question === 'string' ? payload.question.trim() : '';
  if (!question) {
    sendJson(res, 400, { error: 'Question is required' });
    return;
  }
  const id = typeof payload.id === 'string' ? payload.id : randomUUID();

  // Lazy-spawn a worker if none is alive for this session, mirroring compact.
  if (!workerManager.hasWorker(sessionId)) {
    const result = await lazySpawnWorkerForCompact(sessionId, deps, workerDbRequests, res);
    if (!result.ok) return;
  }

  const child = workerManager.getWorker(sessionId);
  if (!child) {
    sendJson(res, 503, { error: 'Worker became unavailable' });
    return;
  }

  const sent = workerManager.sendCommand(sessionId, {
    type: 'side:question',
    sessionId,
    id,
    question,
  });
  if (!sent) {
    sendJson(res, 503, { error: 'Failed to reach worker' });
    return;
  }

  let settled = false;
  const cleanup = (): void => {
    child.removeListener('message', onMessage);
    child.removeListener('exit', onExit);
  };
  const finish = (status: number, data: unknown): void => {
    if (settled) return;
    settled = true;
    cleanup();
    sendJson(res, status, data);
  };
  const onMessage = (msg: Record<string, unknown>): void => {
    if (msg.type !== 'side:answer' || msg.id !== id) return;
    if (msg.error) {
      finish(500, { error: String(msg.error) });
    } else {
      finish(200, { id, answer: typeof msg.answer === 'string' ? msg.answer : '' });
    }
  };
  const onExit = (): void => {
    finish(503, { error: 'Worker exited before answering' });
  };
  child.on('message', onMessage);
  child.on('exit', onExit);

  // Safety timeout so a hung worker cannot hold the connection forever.
  const timeout = setTimeout(() => finish(504, { error: 'Side question timed out' }), 120_000);
  timeout.unref();

  req.on('close', () => {
    clearTimeout(timeout);
    finish(503, { error: 'Request aborted' });
  });

  httpLogger.info('Side question issued', { sessionId, id, charCount: question.length });
}

function handleSessionsRoute(
  method: string,
  sessionId: string,
  pathParts: string[],
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: RouterDeps,
  workerDbRequests: Map<string, ChildProcess>,
): void {
  const { sessionManager, workerManager } = deps;

  if (method === 'POST') {
    if (pathParts.length === 3 && pathParts[2] === 'chat') {
      handlePostChat(sessionId, req, res, deps, workerDbRequests);
      return;
    }
    if (pathParts.length === 3 && pathParts[2] === 'compact') {
      handlePostCompact(sessionId, req, res, deps, workerDbRequests);
      return;
    }
    if (pathParts.length === 3 && pathParts[2] === 'btw') {
      void handlePostSideQuestion(sessionId, req, res, deps, workerDbRequests);
      return;
    }
    if (pathParts.length === 3 && pathParts[2] === 'permission') {
      handlePostPermission(sessionId, req, res, deps);
      return;
    }
    if (pathParts.length === 3 && pathParts[2] === 'permission-mode') {
      handlePostPermissionMode(sessionId, req, res, deps);
      return;
    }
  }

  if (method === 'DELETE') {
    if (pathParts.length === 2) {
      const existed = sessionManager.destroySession(sessionId);
      sendJson(res, existed ? 200 : 404, existed ? { ok: true } : { error: 'Session not found' });
      return;
    }
    if (pathParts.length === 3 && pathParts[2] === 'chat') {
      handleDeleteChat(sessionId, res, deps);
      return;
    }
  }

  if (method === 'GET') {
    if (pathParts.length === 3 && pathParts[2] === 'status') {
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        sendJson(res, 404, { status: 'not_found' });
        return;
      }
      const statusResponse: Record<string, unknown> = {
        status: session.state,
        sessionId: session.id,
        createdAt: session.createdAt,
        turnCount: session.turnCount,
        lastEventId: session.lastEventId,
        hasWorker: workerManager.hasWorker(sessionId),
      };
      if (session.lastCheckpointTime) {
        statusResponse.lastCheckpointTime = session.lastCheckpointTime;
      }
      if (session.state === SessionState.COMPLETED) {
        if (session.lastMessages) {
          statusResponse.messages = session.lastMessages;
        }
        if (session.lastDoneData) {
          statusResponse.usage = (session.lastDoneData as Record<string, unknown>).usage;
        }
      }
      if (session.state === SessionState.CRASHED) {
        statusResponse.exitCode = session.exitCode;
        statusResponse.exitSignal = session.exitSignal;
        if (session.lastCheckpoint) {
          statusResponse.lastCheckpoint = session.lastCheckpoint;
        }
      }
      if (session.state === SessionState.ERROR) {
        statusResponse.errorMessage = session.errorMessage;
        statusResponse.errorRetryable = session.errorRetryable;
      }
      sendJson(res, 200, statusResponse);
      return;
    }
    if (pathParts.length === 3 && pathParts[2] === 'history') {
      handleGetHistory(sessionId, req, res, deps);
      return;
    }
    if (pathParts.length === 3 && pathParts[2] === 'chat') {
      handleGetChat(sessionId, req, res, deps);
      return;
    }
  }

  sendJson(res, 404, { error: 'Not Found' });
}

async function handleResearchRoute(
  method: string,
  parts: string[],
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: RouterDeps,
): Promise<void> {
  const { logger, workerManager, dbRequest } = deps;

  // GET /api/research/snapshot/:sessionId
  if (method === 'GET' && parts.length >= 2 && parts[1] === 'snapshot' && parts.length >= 3) {
    const sessionId = parts[2];
    try {
      const row = await dbRequest('researchSession:getBySessionId', {
        sessionId,
      }) as Record<string, unknown> | null;
      if (!row) {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
        });
        res.end();
        return;
      }

      // Also fetch plan steps from the dedicated table
      const runId = row.id as string | undefined;
      let planSteps: unknown[] = [];
      let activities: unknown[] = [];
      let events: unknown[] = [];
      let sources: unknown[] = [];
      let report: unknown = null;
      let citations: unknown[] = [];
      if (runId) {
        try {
          planSteps = await dbRequest('researchPlanStep:getByRunId', { runId }) as unknown[];
        } catch {
          // non-fatal: plan steps may not exist
        }
        try {
          activities = await dbRequest('researchActivity:getByRunId', { runId, visibility: 'user', limit: 200 }) as unknown[];
        } catch {
          // non-fatal: activities may not exist
        }
        try {
          events = await dbRequest('researchEvent:getByRunId', { runId, visibility: 'user', limit: 500 }) as unknown[];
        } catch {
          // non-fatal: events may not exist
        }
        try {
          sources = await dbRequest('researchSource:getByRunId', { runId }) as unknown[];
        } catch {
          // non-fatal: sources may not exist
        }
        try {
          report = await dbRequest('researchReport:getLatest', { runId }) as unknown;
        } catch {
          // non-fatal: report may not exist
        }
        try {
          citations = await dbRequest('researchCitation:getByRunId', { runId }) as unknown[];
        } catch {
          // non-fatal: citations may not exist
        }
      }

      sendJson(res, 200, {
        ...row,
        workerActive: workerManager.hasWorker(sessionId),
        planSteps,
        activities,
        events,
        sources,
        report,
        citations,
      });
    } catch (error) {
      logger.error('Failed to fetch research session', error instanceof Error ? error : new Error(String(error)), { sessionId });
      sendJson(res, 500, { error: 'Database error' });
    }
    return;
  }

  // POST /api/research/clarification
  if (method === 'POST' && parts.length >= 2 && parts[1] === 'clarification') {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 64 * 1024) {
        sendJson(res, 413, { error: 'Payload too large' });
        req.destroy();
      }
    });

    req.on('end', () => {
      let parsed: { requestId?: string; answers?: Record<string, string>; sessionId?: string } = {};
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' });
        return;
      }

      const { requestId, answers, sessionId } = parsed;
      if (!requestId || !answers || !sessionId) {
        sendJson(res, 400, { error: 'Missing requestId, answers, or sessionId' });
        return;
      }

      // Forward clarification resolution through the same stdin command channel
      // used by init/chat:start. The worker command loop reads stdin JSON lines,
      // not child_process IPC messages.
      if (!workerManager.hasWorker(sessionId)) {
        logger.warn('Research clarification: worker not found for session', { sessionId });
        sendJson(res, 404, { error: 'Session not found' });
        return;
      }

      const sent = workerManager.sendCommand(sessionId, {
        type: 'research:clarification:resolve',
        requestId,
        answers,
        sessionId,
      });

      if (!sent) {
        logger.error('Research clarification: failed to send stdin command', { sessionId, requestId });
        sendJson(res, 500, { error: 'Failed to deliver research clarification to worker' });
        return;
      }

      sendJson(res, 200, { ok: true });
    });
    return;
  }

  sendJson(res, 404, { error: 'Not Found' });
}

export function createHandleRequest(
  deps: RouterDeps,
  workerDbRequests: Map<string, ChildProcess>,
  activeConnections: Set<http.ServerResponse>,
  isShuttingDown: () => boolean,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const { sessionManager } = deps;

  return (req: http.IncomingMessage, res: http.ServerResponse): void => {
    if (isShuttingDown()) {
      sendJson(res, 503, { error: 'Server is shutting down' });
      return;
    }

    activeConnections.add(res);
    res.on('close', () => {
      activeConnections.delete(res);
    });

    const method = req.method || 'GET';
    const { parts } = parsePath(req.url || '/');

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, Last-Event-ID',
      });
      res.end();
      return;
    }

    if (parts.length === 0 && method === 'GET') {
      sendJson(res, 200, {
        name: 'duya-agent-server',
        version: '2.0.0',
        uptime: process.uptime(),
        sessionCount: sessionManager.getSessionCount(),
      });
      return;
    }

    if (parts[0] === 'sessions') {
      handleSessionsRoute(method, parts[1] || '', parts, req, res, deps, workerDbRequests);
      return;
    }

    if (parts[0] === 'research') {
      handleResearchRoute(method, parts, req, res, deps).catch(() => {
        sendJson(res, 500, { error: 'Internal server error' });
      });
      return;
    }

    if (parts[0] === 'plugins' && parts[1] === 'reload' && method === 'POST') {
      const count = deps.workerManager.broadcastCommand({ type: 'reload:skills' });
      deps.workerManager.broadcastCommand({ type: 'reload:mcp' });
      sendJson(res, 200, { ok: true, workersNotified: count });
      return;
    }

    if (parts[0] === 'mcp' && parts[1] === 'status' && method === 'POST') {
      // Phase 2A diagnostic chain: ask every worker for its
      // current MCP runtime snapshot. The full snapshot returns
      // asynchronously as a `mcp:status:snapshot` SSE event on
      // the existing chat stream; we do not block the HTTP
      // response. The renderer / settings page listens for the
      // event after sending this request. The body of the
      // request may carry an optional `sessionId` to target a
      // specific worker; absent that, we broadcast.
      const dispatch = (sessionId: string | undefined): void => {
        const count = sessionId
          ? (deps.workerManager.sendCommand(sessionId, { type: 'mcp:status:get' }) ? 1 : 0)
          : deps.workerManager.broadcastCommand({ type: 'mcp:status:get' });
        sendJson(res, 200, { ok: true, workersNotified: count, sessionId: sessionId ?? null });
      };
      readRequestBody(req).then((body) => {
        let sessionId: string | undefined;
        if (body) {
          try {
            const parsed = JSON.parse(body) as { sessionId?: unknown };
            if (typeof parsed.sessionId === 'string') sessionId = parsed.sessionId;
          } catch {
            // Malformed JSON: broadcast to every worker.
          }
        }
        dispatch(sessionId);
      }).catch(() => {
        dispatch(undefined);
      });
      return;
    }

    sendJson(res, 404, { error: 'Not Found' });
  };
}
