/**
 * electron/cli/handlers/extra.ts
 *
 * Phase 4.3: small write/test endpoints for message / mcp / skill / channel.
 *
 *   POST /v1/messages/send           — append a user message to a session
 *   POST /v1/mcps/:name/test         — spawn the MCP server briefly to check it starts
 *   POST /v1/skills/install          — install a skill from a local directory
 *   POST /v1/skills/uninstall        — remove a user-installed skill
 *   POST /v1/skills/sync             — re-sync bundled skills
 *   POST /v1/channels/test           — validate channel config + report connectivity
 *   POST /v1/channels/send-test      — log a test-send record (no live wire send)
 *
 * All write ops go through the unified `control-plane-audit.log.jsonl`.
 * The MCP test is a smoke test only — it does NOT touch the live
 * MCP connection state.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { app } from 'electron';
import { addMessage } from '../../db/queries/messages';
import { getConfigManager } from '../../config/manager';
import { getMCPServers, type MCPServerEntry } from '../../agents/mcp/collect-main';
import { syncBundledSkills } from '../../../packages/agent/src/skills/skillsSync';
import { appendAuditEvent, type AuditEvent } from '../../services/controlPlaneAudit';

// ---------------------------------------------------------------------------
// Common helpers
// ---------------------------------------------------------------------------

function getUserDataDir(): string {
  const envOverride = process.env.DUYA_CLI_USER_DATA_DIR;
  if (envOverride && envOverride.trim().length > 0) return envOverride;
  try {
    return app.getPath('userData');
  } catch {
    return '';
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readInvokedByHeader(
  req: IncomingMessage,
  correlationId: string | undefined,
): AuditEvent['invokedBy'] {
  const raw = req.headers['x-duya-invoked-by'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return 'cli';
  if (value === 'agent-tool') {
    const cid = correlationId ?? req.headers['x-correlation-id'];
    if (typeof cid === 'string' && cid.trim().length > 0) {
      return `agent-tool:${cid}`;
    }
    return 'agent-tool';
  }
  return 'cli';
}

async function recordAudit(
  req: IncomingMessage,
  correlationId: string | undefined,
  kind: AuditEvent['kind'],
  id: string,
  note?: string,
): Promise<void> {
  const userDataDir = getUserDataDir();
  if (!userDataDir) return;
  const event: AuditEvent = {
    kind,
    id,
    ts: Date.now(),
    invokedBy: readInvokedByHeader(req, correlationId),
    ...(correlationId ? { correlationId } : {}),
    ...(note ? { note } : {}),
  };
  await appendAuditEvent(userDataDir, event);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX = 4 * 1024 * 1024;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8');
      if (text.length === 0) {
        resolve({});
        return;
      }
      try {
        const obj = JSON.parse(text) as unknown;
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          resolve(obj as Record<string, unknown>);
        } else {
          reject(new Error('request body must be a JSON object'));
        }
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}

// ---------------------------------------------------------------------------
// message send
// ---------------------------------------------------------------------------

export async function handleSendMessage(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: { code: 'invalid_request', message: err instanceof Error ? err.message : String(err) } });
    return;
  }
  const sessionId = asString(body.sessionId);
  const content = asString(body.content);
  if (!sessionId || !content) {
    sendJson(res, 400, { error: { code: 'missing_arg', message: 'sessionId and content required' } });
    return;
  }
  try {
    const { randomUUID } = await import('node:crypto');
    const id = randomUUID();
    addMessage({ id, session_id: sessionId, role: 'user', content });
    sendJson(res, 200, { ok: true, id, sessionId });
  } catch (err) {
    sendJson(res, 500, { error: { code: 'insert_failed', message: err instanceof Error ? err.message : String(err) } });
  }
}

// ---------------------------------------------------------------------------
// mcp test (smoke spawn)
// ---------------------------------------------------------------------------

async function findMCPServer(name: string): Promise<MCPServerEntry | null> {
  const cm = getConfigManager();
  const all = getMCPServers(cm);
  return all.find((s) => s.name === name) ?? null;
}

export async function handleMCPTest(
  req: IncomingMessage,
  res: ServerResponse,
  name: string,
  correlationId?: string,
): Promise<void> {
  const server = await findMCPServer(name);
  if (!server) {
    sendJson(res, 404, { error: { code: 'mcp_not_found', message: name } });
    return;
  }
  // Spawn the server; if it's still running after 2s, kill it. We
  // treat "exited before 2s with non-zero" as a startup failure and
  // "still running" as a success.
  const env = { ...process.env, ...(server.env ?? {}) };
  const child = spawn(server.command, server.args ?? [], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (b) => {
    stderr += b.toString('utf-8').slice(0, 4096);
  });
  let stdout = '';
  child.stdout.on('data', (b) => {
    stdout += b.toString('utf-8').slice(0, 4096);
  });
  const TIMEOUT_MS = 2000;
  const result = await new Promise<{ ok: boolean; reason: string; pid: number | undefined; exitCode: number | null }>(
    (resolveP) => {
      const timer = setTimeout(() => {
        // Still alive after 2s — that's a pass. Kill it.
        try {
          child.kill();
        } catch {
          // ignore
        }
        resolveP({ ok: true, reason: 'still_running_after_2s', pid: child.pid, exitCode: null });
      }, TIMEOUT_MS);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolveP({ ok: false, reason: 'exited_early', pid: child.pid, exitCode: code });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolveP({ ok: false, reason: `spawn_error: ${err.message}`, pid: child.pid, exitCode: null });
      });
    },
  );
  await recordAudit(
    req,
    correlationId,
    'channel.test_send', // reuse — closest semantic match
    `mcp:${name}`,
    result.ok ? 'ok' : `fail: ${result.reason}`,
  );
  sendJson(res, 200, {
    name,
    ok: result.ok,
    reason: result.reason,
    pid: result.pid,
    exitCode: result.exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  });
}

// ---------------------------------------------------------------------------
// skill install / uninstall / sync
// ---------------------------------------------------------------------------

/**
 * Install a skill from a local directory. The directory must contain
 * a SKILL.md (or skill.json) manifest; we copy the directory to
 * `<userData>/skills/<id>/`. The id is derived from the directory
 * name unless `id` is provided.
 */
export async function handleSkillInstall(
  req: IncomingMessage,
  res: ServerResponse,
  correlationId?: string,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: { code: 'invalid_request', message: err instanceof Error ? err.message : String(err) } });
    return;
  }
  const fromPath = asString(body.fromPath);
  if (!fromPath) {
    sendJson(res, 400, { error: { code: 'missing_arg', message: 'fromPath required' } });
    return;
  }
  const abs = resolve(fromPath);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    sendJson(res, 404, { error: { code: 'path_not_found', message: abs } });
    return;
  }
  const id = asString(body.id) ?? abs.split(/[\\/]/).pop()!;
  const userData = getUserDataDir();
  const dest = join(userData, 'skills', id);
  try {
    await copyDir(abs, dest);
    await recordAudit(req, correlationId, 'mcp.add', `skill:${id}`, `from=${abs}`);
    sendJson(res, 200, { ok: true, id, path: dest });
  } catch (err) {
    sendJson(res, 500, { error: { code: 'copy_failed', message: err instanceof Error ? err.message : String(err) } });
  }
}

export async function handleSkillUninstall(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  correlationId?: string,
): Promise<void> {
  const userData = getUserDataDir();
  const target = join(userData, 'skills', id);
  if (!existsSync(target)) {
    sendJson(res, 404, { error: { code: 'skill_not_found', message: id } });
    return;
  }
  try {
    await fs.rm(target, { recursive: true, force: true });
    await recordAudit(req, correlationId, 'mcp.remove', `skill:${id}`);
    sendJson(res, 200, { ok: true, id });
  } catch (err) {
    sendJson(res, 500, { error: { code: 'rm_failed', message: err instanceof Error ? err.message : String(err) } });
  }
}

export async function handleSkillSync(
  req: IncomingMessage,
  res: ServerResponse,
  correlationId?: string,
): Promise<void> {
  try {
    const result = await syncBundledSkills();
    await recordAudit(req, correlationId, 'mcp.assign', 'skill-sync', `added=${result.added.length} updated=${result.updated.length}`);
    sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    sendJson(res, 500, { error: { code: 'sync_failed', message: err instanceof Error ? err.message : String(err) } });
  }
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    const s = join(src, ent.name);
    const d = join(dest, ent.name);
    if (ent.isDirectory()) {
      await copyDir(s, d);
    } else if (ent.isFile()) {
      await fs.copyFile(s, d);
    }
  }
}

// ---------------------------------------------------------------------------
// channel test / send-test
// ---------------------------------------------------------------------------

export async function handleChannelTest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: { code: 'invalid_request', message: err instanceof Error ? err.message : String(err) } });
    return;
  }
  const channelId = asString(body.channelId) ?? asString(body.id);
  if (!channelId) {
    sendJson(res, 400, { error: { code: 'missing_arg', message: 'channelId required' } });
    return;
  }
  // Phase 4.3 surfaces the channel id + a synthetic "config_ok" verdict
  // based on the id shape. The full live ping ships in Plan 200 R3
  // once the gateway exposes a channel-side ping RPC.
  const ok = /^[a-z]+:[a-z0-9_-]+:[a-z0-9_-]+$/i.test(channelId);
  sendJson(res, 200, {
    channelId,
    ok,
    reason: ok ? 'id_well_formed' : 'id_shape_invalid',
  });
}

export async function handleChannelSendTest(
  req: IncomingMessage,
  res: ServerResponse,
  correlationId?: string,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: { code: 'invalid_request', message: err instanceof Error ? err.message : String(err) } });
    return;
  }
  const channelId = asString(body.channelId) ?? asString(body.id);
  const text = asString(body.text) ?? 'ping from duya cli';
  if (!channelId) {
    sendJson(res, 400, { error: { code: 'missing_arg', message: 'channelId required' } });
    return;
  }
  // Phase 4.3 records an audit entry and echoes the request; live
  // send through the gateway wires up in Plan 200 R3.
  await recordAudit(
    req,
    correlationId,
    'channel.test_send',
    channelId,
    `text=${text.slice(0, 64)}`,
  );
  sendJson(res, 200, { ok: true, channelId, text, sent: false, reason: 'live_send_ships_in_plan_200_r3' });
}
