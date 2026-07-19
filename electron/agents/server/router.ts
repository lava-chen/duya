import * as http from 'http';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { ChildProcess, execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { SessionManager } from './session-store';
import { SessionState, ConductorAction } from './types';
import { WorkerManager } from './worker-manager';
import { CheckpointBatcher } from './checkpoint-batcher';
// @deprecated (plan 221 Phase 7) ConductorService is retained for legacy
// HTTP/SSE routes but no longer the primary execution path. The main chat
// agent now drives conductor mode via injection.
import { ConductorService } from './conductor-service';
import { Logger } from './logger';
import { toLLMProvider, type ApiProvider } from '../../config/provider-types';

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

export interface RouterDeps {
  sessionManager: SessionManager;
  workerManager: WorkerManager;
  checkpointBatcher: CheckpointBatcher;
  /** @deprecated (plan 221 Phase 7) — retained for legacy HTTP/SSE routes. */
  conductorService: ConductorService;
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
  const parts = pathname.split('/').filter(Boolean);
  return { pathname, parts };
}

function mapEventType(eventType: string): string {
  if (eventType === 'chat:done') return 'done';
  if (eventType === 'chat:error') return 'error';
  if (eventType === 'chat:text') return 'text';
  if (eventType === 'chat:thinking') return 'thinking';
  if (eventType === 'chat:tool_use_started') return 'tool_use_started';
  if (eventType === 'chat:tool_use') return 'tool_use';
  if (eventType === 'chat:tool_result') return 'tool_result';
  if (eventType === 'chat:tool_progress') return 'tool_progress';
  if (eventType === 'chat:permission') return 'permission';
  if (eventType === 'chat:context_usage') return 'context_usage';
  if (eventType === 'chat:status') return 'status';
  if (eventType === 'chat:retry') return 'retry';
  if (eventType === 'chat:token_usage') return 'token_usage';
  if (eventType === 'checkpoint') return 'checkpoint';
  if (eventType === 'ready') return 'ready';
  if (eventType === 'memory_warning') return 'memory_warning';
  return 'message';
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

function emitWikiChatDone(event: Record<string, unknown>): void {
  if (event.type !== 'chat:done' || typeof process.send !== 'function') {
    return;
  }

  try {
    process.send({
      type: 'wiki:chat_done',
      payload: event,
    });
  } catch {
    // H2: process.send can throw if the IPC channel is closed.
    // Swallow — the wiki:chat_done notification is best-effort and must not
    // block the SSE done event from being sent to the client.
  }
}

async function handlePostChat(
  sessionId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: RouterDeps,
  workerDbRequests: Map<string, ChildProcess>,
): Promise<void> {
  const { sessionManager, workerManager, checkpointBatcher, logger, httpLogger, sessionLogger } = deps;

  
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
  // session is not permanently stuck.
  const revertStreamingLock = (): void => {
    try {
      const s = sessionManager.getSession(sessionId);
      if (s && s.state === SessionState.STREAMING) {
        sessionManager.transitionState(sessionId, SessionState.IDLE);
      }
    } catch {
      // State may have already changed; ignore
    }
  };

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
    const providerConfig = parsed.providerConfig;
    const workingDirectory = parsed.workingDirectory;
    const defaultWorkspaceDirectory = parsed.defaultWorkspaceDirectory;

    try {
      // Validate session exists in DB before proceeding. Without a
      // chat_sessions row, message persistence would fail with FOREIGN KEY
      // constraint errors, and the agent worker would run uselessly.
      const dbSession = await deps.dbRequest('session:get', { id: sessionId });
      if (!dbSession) {
        httpLogger.warn('Chat rejected: session not found in DB', { sessionId });
        revertStreamingLock();
        sendJson(res, 404, { error: `Session not found: ${sessionId}` });
        return;
      }

      const totalMem = os.totalmem();
      const availableMem = getAvailableMemory();
      const usedRatio = (totalMem - availableMem) / totalMem;

      const MEMORY_THRESHOLD = parseFloat(process.env.DUYA_MEMORY_THRESHOLD || '0.98');
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

      const MAX_CONCURRENT_WORKERS = 16;
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

      const child = workerManager.spawnWorker(sessionId);
      const workerPid = child.pid;
      // M7: Use structured logger
      httpLogger.info('Worker spawned', { sessionId, pid: workerPid });

      // Log ALL worker stdout for debugging - capture everything
      child.stdout?.setEncoding('utf8');
      const stdoutChunks: string[] = [];
      child.stdout?.on('data', (data: string) => {
        stdoutChunks.push(data.toString().substring(0, 200));
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

      // Helper to wait for ready signal from worker.
      // Subscribes to BOTH child.stdout line-scanning AND the IPC channel
      // because worker sendToMain emits on both — stdout can lose frames on
      // Windows + Electron child stdio pipes, but IPC is always reliable.
      const waitForReady = (timeoutMs = 30000): Promise<void> => {
        return new Promise((resolve, reject) => {
          const startedAt = Date.now();
          let recentStdout = '';
          let lineBuffer = '';
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | undefined;

          const onStdout = (data: Buffer): void => {
            const text = data.toString();
            recentStdout += text;
            if (recentStdout.length > 4096) {
              recentStdout = recentStdout.slice(-4096);
            }
            lineBuffer += text;
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() || '';
            for (const rawLine of lines) {
              const line = rawLine.trim();
              if (!line || !line.startsWith('{')) continue;
              try {
                const msg = JSON.parse(line);
                if (
                  (msg.type === 'ready' || msg.type === 'conductor:ready') &&
                  (!msg.sessionId || msg.sessionId === sessionId)
                ) {
                  const waitedMs = Date.now() - startedAt;
                  if (msg.status === 'error') {
                    const errorMsg = typeof msg.error === 'string' ? msg.error : 'Worker initialization failed';
                    logger.error('Worker init failed via stdout', new Error(errorMsg), { sessionId, waitedMs });
                    finish(() => reject(new Error(`Worker initialization failed: ${errorMsg}`)));
                    return;
                  }
                  logger.info('Worker ready via stdout', {
                    sessionId,
                    waitedMs,
                    readyType: msg.type,
                  });
                  finish(resolve);
                  return;
                }
              } catch {
                // Continue
              }
            }
          };

          const onIpc = (msg: Record<string, unknown>): void => {
            if (
              (msg.type === 'ready' || msg.type === 'conductor:ready') &&
              (!msg.sessionId || msg.sessionId === sessionId)
            ) {
              const waitedMs = Date.now() - startedAt;
              if (msg.status === 'error') {
                const errorMsg = typeof msg.error === 'string' ? msg.error : 'Worker initialization failed';
                logger.error('Worker init failed via IPC', new Error(errorMsg), { sessionId, waitedMs });
                finish(() => reject(new Error(`Worker initialization failed: ${errorMsg}`)));
                return;
              }
              logger.info('Worker ready via IPC', {
                sessionId,
                waitedMs,
                readyType: msg.type,
              });
              finish(resolve);
            }
          };

          const finish = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            child.stdout?.removeListener('data', onStdout);
            child.removeListener('message', onIpc);
            fn();
          };

          timer = setTimeout(() => {
            const waitedMs = Date.now() - startedAt;
            const tail = recentStdout.slice(-500).replace(/\s+/g, ' ');
            logger.warn('Worker ready timeout', {
              sessionId,
              waitedMs,
              recentStdoutTail: recentStdout.slice(-2000),
            });
            finish(() => reject(new Error(
              `Worker ready timeout (${waitedMs}ms); last stdout: ${tail}`,
            )));
          }, timeoutMs);

          child.stdout!.on('data', onStdout);
          child.on('message', onIpc);
        });
      };

      // Reject early if provider config is missing or incomplete so the
      // worker does not crash with a misleading initialization timeout.
      if (!providerConfig || !providerConfig.model) {
        httpLogger.warn('Chat rejected: missing provider config', { sessionId });
        child.kill();
        revertStreamingLock();
        sendJson(res, 400, { error: 'No provider or model configured' });
        return;
      }

      // Send init first if provider config is provided
      // M7: Use structured logger
      httpLogger.debug('Sending init command to worker', { sessionId, hasProviderConfig: !!providerConfig });
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
        permissionRules: parsed.options?.permissionRules,
      });

      try {
        httpLogger.debug('Waiting for worker ready...', { sessionId });
        await waitForReady();
        httpLogger.info('Worker ready signal received', { sessionId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // M7: console.error removed — logger.error below covers this
        logger.error('Worker ready timeout', err instanceof Error ? err : new Error(msg), {
          sessionId,
          stdoutPreview: stdoutChunks.slice(-10),
        });
        revertStreamingLock();
        sendJson(res, 500, { error: 'Worker initialization timeout' });
        return;
      }

      const wantsSSE = req.headers.accept?.includes('text/event-stream') ?? false;

      try {
        if (wantsSSE) {
          handlePostChatSSE(sessionId, req, res, child, deps);
        } else {
          handlePostChatNonSSE(sessionId, req, res, child, deps);
        }

        // Pass wikiAgentEnabled from options to worker (passed from frontend)
        const wikiAgentEnabled = parsed.options?.wikiAgentEnabled === true;

        workerManager.sendCommand(sessionId, {
          type: 'chat:start',
          sessionId,
          id: randomUUID(),
          prompt,
          options: { ...(parsed.options || {}), wikiAgentEnabled },
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

function handlePostChatSSE(
  sessionId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  child: ChildProcess,
  deps: RouterDeps,
): void {
  const { sessionManager, workerManager, checkpointBatcher, logger, httpLogger } = deps;


  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });

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
      workerManager.interruptWorker(sessionId);
    }
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

        // Worker sends events directly (no 'data' wrapper since it's from sendEvent)
        // But we need to handle the format where content might be at event.data for some types
        let sseEvent: Record<string, unknown> = event;

        // Convert worker event format to SSE format
        const msgType = event.type as string;

        // Filter out pong events (internal heartbeat, not for SSE clients)
        if (msgType === 'pong') {
          continue;
        }

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
        } else if (msgType === 'chat:context_usage' || msgType === 'chat:token_usage') {
          sseEvent = {
            type: msgType.replace('chat:', ''), // 'context_usage' or 'token_usage'
            data: event,
          };
        } else if (msgType === 'chat:status') {
          sseEvent = {
            type: 'status',
            data: { message: event.status || event.message },
          };
        } else if (msgType === 'ready') {
          // 'ready' type is already correct format
        } else if (msgType === 'chat:agent_progress') {
          sseEvent = {
            type: msgType.replace('chat:', ''),
            data: event,
          };
        } else if (msgType === 'chat:skill_review_started' || msgType === 'chat:skill_review_completed') {
          // Skill-review payloads are already the renderer contract. Keep the
          // worker envelope out of `data`, otherwise the review indicator
          // receives `{ data: { passed, score, ... } }` and cannot resolve.
          sseEvent = {
            type: msgType.replace('chat:', ''),
            data: event.data,
          };
        } else if (msgType.startsWith('chat:research_')) {
          // Worker emits `chat:research_*` events where convertSSEToAgentMessage
          // spreads the inner `data` object onto the top level (no nested `data`
          // key). Re-wrap so the renderer sees `{ type, data: { from, to, ... } }`
          // matching the contract used by every other chat:* path.
          const { type: _t, ...rest } = event as Record<string, unknown>;
          sseEvent = {
            type: msgType.replace('chat:', ''),
            data: rest,
          };
        } else if (msgType === 'chat:research_continue') {
          const { type: _t, ...rest } = event as Record<string, unknown>;
          sseEvent = { type: 'research_continue', data: rest };
        } else if (msgType === 'chat:research_evidence') {
          const { type: _t, ...rest } = event as Record<string, unknown>;
          sseEvent = { type: 'research_evidence', data: rest };
        } else if (msgType === 'chat:research_report') {
          const { type: _t, ...rest } = event as Record<string, unknown>;
          sseEvent = { type: 'research_report', data: rest };
        } else if (msgType === 'chat:done') {
          sseEvent = { type: 'done', data: event };
        } else if (msgType === 'chat:error') {
          // Normalize to { type: 'error', data: { message, code? } } so the
          // renderer can dispatch through the same `case 'error'` path used
          // by every other chat:* event. Surface provider `code` (e.g.
          // `rate_limit_error`, `usage_limit_exceeded`) so the UI can
          // render a tailored banner when the model provider rate-limits us.
          sseEvent = {
            type: 'error',
            data: {
              message: (event.message as string) || 'Unknown error',
              code: event.code,
            },
          };
        } else if (msgType === 'chat:db_persisted') {
          sseEvent = { type: 'db_persisted', data: event };
        } else if (msgType === 'chat:title_generated') {
          sseEvent = { type: 'title_generated', data: event };
        } else if (msgType === 'mcp:reloaded') {
          // Phase 2A diagnostic chain: post-apply summary. Pass
          // through as-is so renderer / settings UI can consume
          // the activeServerKeys + counts directly.
          sseEvent = { type: 'mcp:reloaded', data: event };
        } else if (msgType === 'mcp:status:snapshot') {
          // Phase 2A diagnostic chain: full snapshot returned in
          // response to a `mcp:status:get` command. The settings
          // page renders this directly.
          sseEvent = { type: 'mcp:status:snapshot', data: event };
        } else if (msgType === 'mcp:reload:error') {
          sseEvent = { type: 'mcp:reload:error', data: event };
        }

        const eventType = sseEvent.type || 'unknown';

        if (eventType === 'done') {
          emitWikiChatDone(event);
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
          // still come after done. But if title_generated never arrives within
          // 5s, force-close the SSE connection so the client doesn't hang.
          setTimeout(() => {
            if (!doneReceived && !res.writableEnded) {
              httpLogger.warn('SSE: title_generated not received within 5s after done, closing', { sessionId });
              doneReceived = true;
              res.end();
            }
          }, 5000);
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
          emitWikiChatDone(event);
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
  const { sessionManager, workerManager, httpLogger } = deps;
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

  const interrupted = workerManager.interruptWorker(sessionId);
  sendJson(res, 200, { ok: true, interrupted });
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

const MAX_CONCURRENT_WORKERS = 16;

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

  const MEMORY_THRESHOLD = parseFloat(process.env.DUYA_MEMORY_THRESHOLD || '0.98');
  if (usedRatio > MEMORY_THRESHOLD) {
    logger.warn('System memory usage high, rejecting compact lazy-spawn', { usedRatio, totalMem, availableMem, sessionId });
    sendJson(res, 503, { error: 'System memory usage is high', retryAfterSec: 30 });
    return { ok: false };
  }
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

  // Wait for ready (30s).
  const waitForReady = (): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Worker ready timeout (30s)'));
      }, 30000);
      let readyBuffer = '';
      const readyHandler = (data: Buffer): void => {
        readyBuffer += data.toString();
        const lines = readyBuffer.split('\n');
        readyBuffer = lines.pop() || '';
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || !line.startsWith('{')) continue;
          try {
            const m = JSON.parse(line);
            if (m.type === 'ready' || m.type === 'conductor:ready') {
              clearTimeout(timeout);
              cleanup();
              resolve();
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
  };

  try {
    await waitForReady();
    httpLogger.info('Compact: lazy-spawned worker ready', { sessionId });
    return { ok: true, child, init };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Compact lazy-spawn: worker ready timeout', err instanceof Error ? err : new Error(msg), { sessionId });
    sendJson(res, 500, { error: `Worker initialization timeout: ${msg}` });
    return { ok: false };
  }
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
        const eventType = event.type || 'unknown';

        seqNum++;

        if (eventType === 'chat:done') {
          res.write(`event: done\nid: ${seqNum}\ndata: ${JSON.stringify(event)}\n\n`);
          doneReceived = true;
          res.end();
          child.stdout!.removeListener('data', onData);
          return;
        }

        if (eventType === 'chat:error') {
          // Normalize to { type: 'error', data: { message, code? } } so the
          // renderer dispatches through the same `case 'error'` path used
          // by every other chat:* event, and can show tailored banners for
          // provider error codes (rate_limit_error, usage_limit_exceeded).
          const errorMessage = event.message || 'Unknown error';
          sessionManager.failSession(sessionId, errorMessage, true);
          res.write(`event: error\nid: ${seqNum}\ndata: ${JSON.stringify({
            type: 'error',
            data: {
              message: errorMessage,
              code: event.code,
            },
          })}\n\n`);
          doneReceived = true;
          res.end();
          child.stdout!.removeListener('data', onData);
          return;
        }

        const sseEventType = mapEventType(eventType);
        res.write(`event: ${sseEventType}\nid: ${seqNum}\ndata: ${JSON.stringify(event)}\n\n`);
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
    if (pathParts.length === 3 && pathParts[2] === 'permission') {
      handlePostPermission(sessionId, req, res, deps);
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

function handleConductorRoute(
  method: string,
  pathParts: string[],
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: RouterDeps,
): void {
  const { conductorService } = deps;

  if (pathParts.length < 2) {
    if (method === 'GET') {
      sendJson(res, 200, { sessions: conductorService.listSessions() });
      return;
    }
    sendJson(res, 404, { error: 'Not Found' });
    return;
  }

  const conductorId = pathParts[1];

  if (method === 'GET' && pathParts.length === 3 && pathParts[2] === 'stream') {
    handleConductorStream(conductorId, req, res, deps);
    return;
  }

  if (method === 'POST' && pathParts.length === 3 && pathParts[2] === 'execute') {
    handleConductorExecute(conductorId, req, res, deps);
    return;
  }

  if (method === 'POST' && pathParts.length === 3 && pathParts[2] === 'action') {
    handleConductorAction(conductorId, req, res, deps);
    return;
  }

  if (method === 'DELETE' && pathParts.length === 3 && pathParts[2] === 'execute') {
    handleConductorInterrupt(conductorId, req, res, deps);
    return;
  }

  if (method === 'GET' && pathParts.length === 3 && pathParts[2] === 'status') {
    const status = conductorService.getStatus(conductorId);
    if (!status) {
      sendJson(res, 404, { error: 'Conductor session not found' });
      return;
    }
    sendJson(res, 200, status);
    return;
  }

  if (method === 'DELETE' && pathParts.length === 2) {
    const existed = conductorService.destroySession(conductorId);
    sendJson(res, existed ? 200 : 404, existed ? { ok: true } : { error: 'Session not found' });
    return;
  }

  sendJson(res, 404, { error: 'Not Found' });
}

function handleConductorStream(
  conductorId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: RouterDeps,
): void {
  const { conductorService, httpLogger } = deps;

  httpLogger.info('Conductor route: stream opening', { conductorId });

  let session = conductorService.getSession(conductorId);

  if (!session) {
    httpLogger.info('Conductor route: stream - session not found, creating', { conductorId });
    const canvasId = conductorId.replace(/^conductor-/, '');
    // @deprecated (plan 221 Phase 7) Legacy conductor session create.
    conductorService.createSession(canvasId).then((s) => {
      session = s;
      httpLogger.info('Conductor route: stream - session created', { conductorId, canvasId });
      attachConductorSSE(session.id, req, res, deps);
    }).catch((err) => {
      httpLogger.error('Conductor route: stream - session create failed', err instanceof Error ? err : new Error(String(err)), { conductorId });
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
    return;
  }

  httpLogger.info('Conductor route: stream - using existing session', { conductorId, sessionState: session.state });
  attachConductorSSE(conductorId, req, res, deps);
}

function attachConductorSSE(
  conductorId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: RouterDeps,
): void {
  const { conductorService, httpLogger } = deps;

  httpLogger.info('Conductor attachSSE: setting up response', { conductorId });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });

  const session = conductorService.getSession(conductorId);
  if (!session) {
    httpLogger.warn('Conductor attachSSE: session not found', { conductorId });
    res.write(`event: error\ndata: ${JSON.stringify({ message: 'Session not found' })}\n\n`);
    res.end();
    return;
  }

  httpLogger.info('Conductor attachSSE: adding client to session', { conductorId, existingClients: session.sseClients.size });
  conductorService.addSSEClient(conductorId, res);

  httpLogger.info('Conductor attachSSE: sending connected event', { conductorId, sessionState: session.state });
  res.write(`event: connected\ndata: ${JSON.stringify({ sessionId: conductorId, state: session.state })}\n\n`);

  req.on('close', () => {
    httpLogger.info('Conductor attachSSE: client connection closed', { conductorId });
  });
}

function handleConductorExecute(
  conductorId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: RouterDeps,
): void {
  const { conductorService, httpLogger } = deps;

  httpLogger.info('Conductor route: execute request received', { conductorId });

  let body = '';
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString();
    if (body.length > 1024 * 1024) {
      sendJson(res, 413, { error: 'Payload too large' });
      req.destroy();
    }
  });

  req.on('end', async () => {
    let parsed: {
      prompt?: string;
      providerConfig?: Record<string, unknown>;
      agentId?: string;
      agentName?: string;
      workingDirectory?: string;
      systemPrompt?: string;
    };
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    if (!parsed.prompt) {
      sendJson(res, 400, { error: 'Missing required field: prompt' });
      return;
    }

    if (!parsed.providerConfig) {
      sendJson(res, 400, { error: 'Missing required field: providerConfig' });
      return;
    }

    httpLogger.info('Conductor route: execute parsed body', {
      conductorId,
      promptLength: parsed.prompt.length,
      hasProviderConfig: !!parsed.providerConfig,
      agentId: parsed.agentId,
      agentName: parsed.agentName,
    });

    let session = conductorService.getSession(conductorId);
    if (!session) {
      httpLogger.info('Conductor route: execute - session not found, creating', { conductorId });
      const canvasId = conductorId.replace(/^conductor-/, '');
      try {
        // @deprecated (plan 221 Phase 7) Legacy conductor session create.
        session = await conductorService.createSession(canvasId);
        httpLogger.info('Conductor route: execute - session created', { conductorId, canvasId });
      } catch (err) {
        httpLogger.error('Conductor route: execute - session create failed', err instanceof Error ? err : new Error(String(err)), { conductorId });
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
    } else {
      httpLogger.info('Conductor route: execute - using existing session', {
        conductorId,
        sessionState: session.state,
        sseClientCount: session.sseClients.size,
        subAgentCount: session.subAgents.size,
      });
    }

    try {
      // @deprecated (plan 221 Phase 7) Legacy conductor worker spawn path.
      // Retained for backward compatibility with older renderer builds;
      // the main chat agent is the preferred execution path now.
      await conductorService.executeTurn(conductorId, parsed.prompt, parsed.providerConfig, {
        agentId: parsed.agentId,
        agentName: parsed.agentName,
        workingDirectory: parsed.workingDirectory,
        systemPrompt: parsed.systemPrompt,
      });
      httpLogger.info('Conductor route: execute - executeTurn succeeded', { conductorId });
      sendJson(res, 200, { ok: true, sessionId: conductorId });
    } catch (err) {
      httpLogger.error('Conductor route: execute - executeTurn failed', err instanceof Error ? err : new Error(String(err)), { conductorId });
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

function handleConductorAction(
  conductorId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: RouterDeps,
): void {
  const { conductorService } = deps;

  let body = '';
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString();
    if (body.length > 256 * 1024) {
      sendJson(res, 413, { error: 'Payload too large' });
      req.destroy();
    }
  });

  req.on('end', async () => {
    let parsed: ConductorAction;
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    if (!parsed.action) {
      sendJson(res, 400, { error: 'Missing required field: action' });
      return;
    }

    try {
      await conductorService.handleUserAction(conductorId, parsed);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found')) {
        sendJson(res, 404, { error: message });
      } else {
        sendJson(res, 500, { error: message });
      }
    }
  });
}

function handleConductorInterrupt(
  conductorId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: RouterDeps,
): void {
  const { conductorService } = deps;

  let body = '';
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString();
  });

  req.on('end', () => {
    let parsed: { agentId?: string } = {};
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      // use empty
    }

    try {
      conductorService.interruptTurn(conductorId, parsed.agentId);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found')) {
        sendJson(res, 404, { error: message });
      } else {
        sendJson(res, 500, { error: message });
      }
    }
  });
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

    if (parts[0] === 'conductor') {
      handleConductorRoute(method, parts, req, res, deps);
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
