/**
 * electron/automation/agent-run.ts
 *
 * Cron execution through the main agent HTTP channel — the same
 * `POST /sessions/:id/chat` endpoint the renderer chat and the gateway use.
 * A cron run is an ordinary agent session (mode='chat', source='cron') that a
 * system component kicks off by sending it a prompt; its history lives in the
 * session's rollout.
 *
 * Interactive tools stay suppressed for headless runs via the `cron` agent
 * profile deny list (AskUserQuestion / show_widget / Agent / canvas:* /
 * mode-switch) passed as `options.agentProfileId`. See Scheduler.ts history:
 * without a restrictive profile the agent falls back to the full toolset and
 * interactive tools hang forever.
 */

import * as http from 'node:http';
import { BrowserWindow } from 'electron';
import { getAgentServerPort } from '../agents/agent-server-lifecycle';
import { getCoreStores } from '../db/core-connection';
import { getLogger, LogComponent } from '../logging/logger';
import { toLLMProvider } from '../config/provider-types.js';
import { resolveCronProvider } from './provider';
import { prepareAutomationWorkspace } from './workspace';
import type { AutomationCron } from './types.js';

const RUN_TIMEOUT_MS = 10 * 60_000;

export interface CronProviderConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  provider: string;
  authStyle: 'api_key';
}

export interface RunPromptInSessionOptions {
  sessionId: string;
  prompt: string;
  workingDirectory: string;
  providerConfig: CronProviderConfig;
  options?: Record<string, unknown>;
  timeoutMs?: number;
  onText?: (text: string) => void;
}

export interface RunPromptResult {
  output: string;
  events: Array<{ type: string; data?: unknown }>;
}

/**
 * Create the core session row for a cron run. The Agent Server rejects a chat
 * POST when the session row is missing (router 404), so this MUST run first.
 * Idempotent: reuses an existing row for the same session id (runCronNow may
 * create it eagerly so the UI can open the run view immediately).
 */
export function createCronSessionRow(params: {
  sessionId: string;
  title: string;
  model: string;
  providerId: string;
  workingDirectory: string;
  cronId: string;
}): void {
  const { sessions } = getCoreStores();
  if (sessions.get(params.sessionId)) return;
  sessions.create({
    id: params.sessionId,
    title: params.title,
    model: params.model,
    providerId: params.providerId,
    workingDirectory: params.workingDirectory,
    status: 'active',
    mode: 'chat',
    permissionMode: 'default',
    extensions: {
      source: 'cron',
      cron_job_id: params.cronId,
      system_prompt: '',
      context_summary: '',
      context_summary_updated_at: 0,
    },
  });
  // A cron run is created by the main process, outside any renderer action,
  // so the normal `sync:threads-changed` path (renderer → main → other
  // windows) never fires for it. Broadcast to every window so the session
  // list and sidebar cron group pick up the new run without a manual refresh.
  broadcastThreadsChanged(params.sessionId);
}

/**
 * Best-effort broadcast of `sync:threads-changed` to every renderer window.
 * The renderer handler force-syncs the session list on receipt, so a
 * scheduled run shows up in the UI while it is still executing. Swallows
 * failures (headless boot / CLI bootstrap have no windows at all).
 */
function broadcastThreadsChanged(sessionId: string): void {
  try {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('sync:threads-changed');
      }
    }
  } catch (error) {
    getLogger().warn(
      'Failed to broadcast threads-changed after cron session creation',
      { sessionId, error: error instanceof Error ? error.message : String(error) },
      LogComponent.Automation,
    );
  }
}

/**
 * POST a prompt to the main agent session and collect the streamed reply.
 * Resolves on the SSE `done` event, rejects on `error` / timeout / non-2xx.
 */
export function runPromptInSession(opts: RunPromptInSessionOptions): Promise<RunPromptResult> {
  const port = getAgentServerPort();
  if (!port) throw new Error('agent server not running');
  const timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS;
  const startedAt = Date.now();
  const body = JSON.stringify({
    prompt: opts.prompt,
    providerConfig: opts.providerConfig,
    workingDirectory: opts.workingDirectory,
    defaultWorkspaceDirectory: opts.workingDirectory,
    options: opts.options ?? {},
  });

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        hostname: '127.0.0.1',
        port,
        path: `/sessions/${encodeURIComponent(opts.sessionId)}/chat`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Accept': 'text/event-stream',
        },
      },
      (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          let errBuf = '';
          res.on('data', (c: Buffer) => (errBuf += c.toString()));
          res.on('end', () => {
            reject(new Error(`agent server returned ${res.statusCode}: ${errBuf.slice(0, 200)}`));
          });
          return;
        }

        const chunks: string[] = [];
        const events: RunPromptResult['events'] = [];
        let sseBuffer = '';
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error('cron run timeout'));
        }, timeoutMs);
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          fn();
        };

        res.on('data', (chunk: Buffer) => {
          sseBuffer += chunk.toString();
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            let event: { type?: string; data?: Record<string, unknown> };
            try {
              event = JSON.parse(line.slice(6));
            } catch {
              continue; // partial SSE frame; wait for the rest
            }
            if (!event || typeof event.type !== 'string') continue;
            events.push({ type: event.type, data: event.data });

            if (event.type === 'text') {
              const content = typeof event.data?.content === 'string' ? event.data.content : '';
              chunks.push(content);
              opts.onText?.(content);
            } else if (event.type === 'error') {
              const message = typeof event.data?.message === 'string' ? event.data.message : 'agent error';
              finish(() => reject(new Error(message)));
              return;
            } else if (event.type === 'done') {
              const output = chunks.join('').trim() || `completed in ${Date.now() - startedAt}ms`;
              finish(() => resolve({ output, events }));
              return;
            }
          }
        });

        res.on('error', (e: Error) => finish(() => reject(e)));
        res.on('end', () => finish(() => reject(new Error('stream ended without done'))));
      },
    );

    req.on('error', (e: Error) => reject(e));
    req.write(body);
    req.end();
  });
}

/**
 * Best-effort interrupt of an in-flight session's chat (DELETE /sessions/:id/chat).
 * Used by the `replace` concurrency policy to stop a previous run.
 */
export function interruptCronSession(sessionId: string): void {
  const port = getAgentServerPort();
  if (!port) return;
  const req = http.request({
    method: 'DELETE',
    hostname: '127.0.0.1',
    port,
    path: `/sessions/${encodeURIComponent(sessionId)}/chat`,
  });
  req.on('error', () => { /* best effort: the run may already have finished */ });
  req.end();
}

/**
 * Run a cron job end-to-end: resolve provider + model, create the session row,
 * POST the prompt to the main agent channel, collect the reply.
 */
export async function runCronInSession(job: AutomationCron, sessionId: string): Promise<RunPromptResult> {
  const { provider, model } = resolveCronProvider(job.model);
  const workingDirectory = prepareAutomationWorkspace(job.workingDirectory);
  createCronSessionRow({
    sessionId,
    title: `[Cron] ${job.name}`,
    model,
    providerId: provider.id,
    workingDirectory,
    cronId: job.id,
  });

  getLogger().info('Cron run starting', {
    cronId: job.id,
    sessionId,
    model,
    provider: provider.id,
    effort: 'off',
    llmRequestTimeoutMs: 240_000,
  }, LogComponent.Automation);

  return runPromptInSession({
    sessionId,
    prompt: job.prompt,
    workingDirectory,
    providerConfig: {
      apiKey: provider.apiKey,
      baseURL: provider.baseUrl,
      model,
      provider: toLLMProvider(provider.providerType),
      authStyle: 'api_key',
    },
    options: { agentProfileId: 'cron', effort: 'off', llmRequestTimeoutMs: 240_000 },
  });
}
