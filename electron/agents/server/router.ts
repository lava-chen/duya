import * as http from 'http';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { ChildProcess } from 'child_process';
import { SessionManager } from './session-store';
import { SessionState, ConductorAction } from './types';
import { WorkerManager } from './worker-manager';
import { CheckpointBatcher } from './checkpoint-batcher';
import { ConductorService } from './conductor-service';
import { Logger } from './logger';

export interface RouterDeps {
  sessionManager: SessionManager;
  workerManager: WorkerManager;
  checkpointBatcher: CheckpointBatcher;
  conductorService: ConductorService;
  logger: Logger;
  httpLogger: Logger;
  sessionLogger: Logger;
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

function emitWikiChatDone(event: Record<string, unknown>): void {
  if (event.type !== 'chat:done' || typeof process.send !== 'function') {
    return;
  }

  process.send({
    type: 'wiki:chat_done',
    payload: event,
  });
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

  if (session.state === SessionState.STREAMING || session.state === SessionState.COMPLETING) {
    httpLogger.warn('Session busy, rejecting chat', { sessionId, state: session.state });
    sendJson(res, 409, { error: `Session is busy: ${session.state}`.trim() });
    return;
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

  // 50MB default limit for chat payloads (supports file attachments with base64 data)
  const MAX_CHAT_PAYLOAD_SIZE = parseInt(process.env.DUYA_MAX_CHAT_PAYLOAD_SIZE || '52428800', 10);

  let body = '';
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString();
    if (body.length > MAX_CHAT_PAYLOAD_SIZE) {
      sendJson(res, 413, { error: 'Payload too large' });
      req.destroy();
    }
  });

  req.on('end', async () => {
    let parsed: { prompt?: string; options?: Record<string, unknown>; providerConfig?: Record<string, unknown>; workingDirectory?: string; systemPrompt?: string };
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    // DEBUG: log file attachments received in POST body

    const prompt = parsed.prompt || '';
    const providerConfig = parsed.providerConfig;
    const workingDirectory = parsed.workingDirectory;

    try {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedRatio = (totalMem - freeMem) / totalMem;

      const MEMORY_THRESHOLD = parseFloat(process.env.DUYA_MEMORY_THRESHOLD || '0.95');
      if (usedRatio > MEMORY_THRESHOLD) {
        logger.warn('System memory usage high, rejecting chat', { usedRatio, totalMem, freeMem, sessionId });
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
      console.log('[agent-server] Worker spawned', { sessionId, pid: workerPid });

      // Log ALL worker stdout for debugging - capture everything
      child.stdout?.setEncoding('utf8');
      const stdoutChunks: string[] = [];
      child.stdout?.on('data', (data: string) => {
        stdoutChunks.push(data.toString().substring(0, 200));
        console.log('[agent-server] Worker stdout:', data.toString().substring(0, 300));
      });

      child.on('message', (msg: Record<string, unknown>) => {
        if (msg.type === 'db:request' && typeof msg.id === 'string' && process.send) {
          workerDbRequests.set(msg.id, child);
          process.send(msg);
        }
      });


      child.on('error', (err) => {
        logger.error('Worker spawn error', err, { sessionId });
        if (!res.headersSent) {
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

      // Helper to wait for ready signal from worker via stdout
      const waitForReady = (): Promise<void> => {
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('Worker ready timeout (30s)'));
          }, 30000);

          const readyHandler = (data: Buffer): void => {
            const buffer = data.toString();
            const lines = buffer.split('\n');
            for (const line of lines) {
              if (!line.trim() || !line.startsWith('{')) continue;
              try {
                const msg = JSON.parse(line);
                if (msg.type === 'ready' || msg.type === 'conductor:ready') {
                  clearTimeout(timeout);
                  cleanup();
                  resolve();
                  return;
                }
              } catch {
                // Continue
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

      // Send init first if provider config is provided
      console.log('[agent-server] Sending init command to worker', { sessionId, hasProviderConfig: !!providerConfig });
      workerManager.sendCommand(sessionId, {
        type: 'init',
        sessionId,
        providerConfig,
        workingDirectory: workingDirectory || '',
        systemPrompt: parsed.systemPrompt,
        language: 'zh',
        communicationPlatform: parsed.options?.platform,
      });

      try {
        console.log('[agent-server] Waiting for worker ready...', { sessionId });
        await waitForReady();
        console.log('[agent-server] Worker ready signal received', { sessionId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[agent-server] Worker ready timeout', msg, { sessionId });
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

        workerManager.sendCommand(sessionId, {
          type: 'chat:start',
          sessionId,
          id: randomUUID(),
          prompt,
          options: parsed.options || {},
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, 500, { error: message });
        return;
      }
    } catch {
      // Fallback catch for req.on('end') try block - already handled above
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
  const { sessionManager, checkpointBatcher, logger, httpLogger } = deps;


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
  // Accumulate checkpoint messages in memory, write to DB only on done/error
  let pendingMessages: unknown[] = [];

  req.on('close', () => {
    // Don't set doneReceived=true here - let the worker complete and we'll flush messages
    // The client might have disconnected but the server can still try to send remaining data
  });

  // Read events from worker stdout (JSON lines via sendEvent)
  const onData = (data: Buffer): void => {
    if (doneReceived) return;

    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

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
        } else if (msgType === 'chat:tool_use') {
          sseEvent = {
            type: 'tool_use',
            data: { id: event.id, name: event.name, input: event.input },
          };
        } else if (msgType === 'chat:tool_result') {
          sseEvent = {
            type: 'tool_result',
            data: { id: event.id, result: event.result, error: event.error },
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
        } else if (msgType === 'chat:agent_progress' || msgType === 'chat:skill_review_started' || msgType === 'chat:skill_review_completed') {
          sseEvent = {
            type: msgType.replace('chat:', ''),
            data: event,
          };
        } else if (msgType === 'chat:done') {
          sseEvent = { type: 'done', data: event };
        } else if (msgType === 'chat:db_persisted') {
          sseEvent = { type: 'db_persisted', data: event };
        } else if (msgType === 'chat:title_generated') {
          sseEvent = { type: 'title_generated', data: event };
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
            process.send(flushMsg);
            pendingMessages = [];
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
          // Don't set doneReceived=true here - title_generated event may still come after done
          // We close the connection when title_generated is received (or on error/close)
          return;
        }

        if (eventType === 'title_generated') {
          // Send title generated event and close SSE connection
          seqNum++;
          sessionManager.updateLastEventId(sessionId, seqNum);
          sessionManager.recordEvent(sessionId, 'title_generated', sseEvent, seqNum);
          res.write(`event: title_generated\nid: ${seqNum}\ndata: ${JSON.stringify(sseEvent)}\n\n`);
          console.log('[agent-server] Sent title_generated event, closing SSE');
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
            process.send(flushMsg);
            pendingMessages = [];
          }
          checkpointBatcher.flush();
          seqNum++;
          sessionManager.updateLastEventId(sessionId, seqNum);
          sessionManager.recordEvent(sessionId, 'error', sseEvent as unknown, seqNum);
          const errData = sseEvent.data as { message?: string } | undefined;
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
      } catch (err) {
        console.warn('[agent-server] Failed to parse worker stdout line:', rawLine.substring(0, 100), err);
      }
    }
  };

  child.stdout!.on('data', onData);

  child.on('error', (err: Error) => {
    httpLogger.error('Worker error', err, { sessionId });
    if (!doneReceived && res.writable) {
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', data: { message: err.message } })}\n\n`);
      doneReceived = true;
      res.end();
    }
  });

  child.on('exit', () => {
    child.stdout?.removeListener('data', onData);
    if (!doneReceived && res.writable) {
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

  child.stdout!.on('data', (data: Buffer) => {
    if (doneReceived) return;

    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) {
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
        // Skip
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
  const { workerManager, httpLogger } = deps;
  httpLogger.info('Chat interruption requested', { sessionId });
  workerManager.killWorker(sessionId);
  sendJson(res, 200, { ok: true });
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

function handlePostCompact(
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

  if (session.state === SessionState.STREAMING || session.state === SessionState.COMPLETING) {
    httpLogger.warn('Session busy, rejecting compact', { sessionId, state: session.state });
    sendJson(res, 409, { error: `Session is busy: ${session.state}` });
    return;
  }

  if (!workerManager.hasWorker(sessionId)) {
    sendJson(res, 404, { error: 'No worker for session' });
    return;
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
    sendJson(res, 404, { error: 'No worker for session' });
    return;
  }

  // Send compact command to worker
  workerManager.sendCommand(sessionId, { type: 'compact', sessionId });

  // Listen for compact events from worker stdout
  let compactDone = false;
  const onData = (data: Buffer): void => {
    if (compactDone) return;

    const line = data.toString().trim();
    if (!line || !line.startsWith('{')) return;

    try {
      const event = JSON.parse(line);
      const eventType = event.type as string;

      if (eventType === 'compact:done') {
        httpLogger.info('Compaction done', { sessionId });
        res.write(`event: compact:done\ndata: ${JSON.stringify(event)}\n\n`);
        compactDone = true;
        res.end();
        child.stdout?.removeListener('data', onData);
        return;
      }

      if (eventType === 'compact:error') {
        httpLogger.error('Compaction error', new Error(event.message || 'Unknown error'), { sessionId });
        res.write(`event: compact:error\ndata: ${JSON.stringify(event)}\n\n`);
        compactDone = true;
        res.end();
        child.stdout?.removeListener('data', onData);
        return;
      }
    } catch {
      // Ignore parse errors
    }
  };

  child.stdout?.on('data', onData);

  child.on('exit', () => {
    if (!compactDone) {
      httpLogger.warn('Worker exited during compaction', { sessionId });
      res.write(`event: compact:error\ndata: ${JSON.stringify({ type: 'compact:error', sessionId, message: 'Worker exited' })}\n\n`);
      compactDone = true;
      res.end();
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

  httpLogger.info('SSE reconnection', { sessionId, lastEventId });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });

  let seqNum = 0;
  let doneReceived = false;

  const onData = (data: Buffer) => {
    if (doneReceived) return;

    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      if (doneReceived) return;

      try {
        const event = JSON.parse(line);
        const eventType = event.type || 'unknown';

        seqNum++;
        if (seqNum <= lastEventId) continue;

        if (eventType === 'chat:done') {
          res.write(`event: done\nid: ${seqNum}\ndata: ${JSON.stringify(event)}\n\n`);
          doneReceived = true;
          res.end();
          child.stdout!.removeListener('data', onData);
          return;
        }

        if (eventType === 'chat:error') {
          res.write(`event: error\nid: ${seqNum}\ndata: ${JSON.stringify(event)}\n\n`);
          doneReceived = true;
          res.end();
          child.stdout!.removeListener('data', onData);
          return;
        }

        const sseEventType = mapEventType(eventType);
        res.write(`event: ${sseEventType}\nid: ${seqNum}\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Skip invalid JSON
      }
    }
  };

  child.stdout!.on('data', onData);

  child.on('exit', () => {
    if (!doneReceived && res.writable) {
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
      handlePostCompact(sessionId, req, res, deps);
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

    sendJson(res, 404, { error: 'Not Found' });
  };
}
