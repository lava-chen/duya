/**
 * electron/cli/handlers/mcps.ts
 *
 * CLI API handlers for MCP server control plane.
 *
 * Read surface (frozen in Plan 96 / Plan 99):
 *   GET    /v1/mcps             → { mcps: MCPListItemDTO[] }
 *   GET    /v1/mcps/:id         → { mcp: MCPInfoItemDTO }
 *
 * Write surface (Plan 99 §3.3 Phase 7 + Plan 102):
 *   POST   /v1/mcps             → add MCP server (body: { name, command, args?, env?, allowedAgentIds? })
 *   DELETE /v1/mcps/:name       → remove MCP server
 *   PATCH  /v1/mcps/:name       → assign allowed agent profiles
 *
 * The read path uses `collectMainMCPCandidates` so the GUI and CLI
 * server produce identical winner classifications.
 *
 * The write path reads from / writes to `agentSettings.mcpServers`
 * in ConfigManager (matches the legacy `duya_config mcp_server_*`
 * contract exactly).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { collectMainMCPCandidates } from '../../agents/mcp/collect-main.js';
import {
  toMCPListDTO,
  toMCPInfoDTO,
  type MCPListItem,
  type MCPInfoItem,
} from '../../../packages/agent/src/mcp/mcpService.js';
import { getConfigManager } from '../../config/manager';
import { appendAuditEvent, type AuditEvent } from '../../services/controlPlaneAudit';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Read surface (existing)
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

export async function handleListMCPs(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const collected = await collectMainMCPCandidates();
    const skills: MCPListItem[] = toMCPListDTO(collected);
    sendJson(res, 200, { mcps: skills });
  } catch (err) {
    sendJson(res, 500, {
      error: {
        code: 'internal_error',
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

export async function handleGetMCP(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  try {
    const collected = await collectMainMCPCandidates();
    const info: MCPInfoItem | null = toMCPInfoDTO(collected, id);
    if (!info) {
      sendJson(res, 404, {
        error: {
          code: 'mcp_not_found',
          message: `MCP '${id}' not found`,
        },
      });
      return;
    }
    sendJson(res, 200, { mcp: info });
  } catch (err) {
    sendJson(res, 500, {
      error: {
        code: 'internal_error',
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Write surface (Plan 99 §3.3 Phase 7 + Plan 102)
// ---------------------------------------------------------------------------

interface MCPServerEntry {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  allowedAgentIds?: string[];
}

type InvokedBy = 'cli' | 'agent-tool' | `agent-tool:${string}`;

function getUserDataDir(): string {
  const envOverride = process.env.DUYA_CLI_USER_DATA_DIR;
  if (envOverride && envOverride.trim().length > 0) return envOverride;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return app.getPath('userData');
    }
  } catch {
    // not in electron context
  }
  return join(homedir(), '.duya');
}

function readAuditContext(req: IncomingMessage): {
  invokedBy: InvokedBy;
  correlationId?: string;
} {
  const invokedHeader = req.headers['x-duya-invoked-by'];
  const correlationHeader = req.headers['x-correlation-id'];
  const invokedByRaw = Array.isArray(invokedHeader) ? invokedHeader[0] : invokedHeader;
  const correlationIdRaw = Array.isArray(correlationHeader) ? correlationHeader[0] : correlationHeader;
  return {
    invokedBy: (invokedByRaw as InvokedBy | undefined) ?? 'cli',
    correlationId: typeof correlationIdRaw === 'string' ? correlationIdRaw : undefined,
  };
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
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
        reject(new Error(`malformed JSON body: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on('error', reject);
  });
}

function getMCPServers(cm: ReturnType<typeof getConfigManager>): MCPServerEntry[] {
  const settings = cm.getAgentSettings() as unknown as Record<string, unknown>;
  return Array.isArray(settings.mcpServers)
    ? (settings.mcpServers as MCPServerEntry[])
    : [];
}

async function audit(
  req: IncomingMessage,
  kind: 'mcp.add' | 'mcp.remove' | 'mcp.assign',
  id: string,
  note?: string,
): Promise<void> {
  const ctx = readAuditContext(req);
  const event: AuditEvent = {
    kind,
    id,
    ts: Date.now(),
    invokedBy: ctx.invokedBy,
    ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
    ...(note ? { note } : {}),
  };
  await appendAuditEvent(getUserDataDir(), event);
}

export async function handleAddMCP(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch (err) {
    sendError(res, 400, 'invalid_request', err instanceof Error ? err.message : String(err));
    return;
  }
  const name = typeof body.name === 'string' ? body.name : '';
  const command = typeof body.command === 'string' ? body.command : '';
  if (!name || !command) {
    sendError(res, 400, 'invalid_request', 'name and command are required');
    return;
  }
  try {
    const cm = getConfigManager();
    const current = getMCPServers(cm);
    if (current.some((s) => s.name === name)) {
      sendError(
        res,
        409,
        'mcp_already_exists',
        `MCP server "${name}" already exists. Use mcp assign to modify.`,
      );
      return;
    }
    const args = Array.isArray(body.args) ? (body.args as unknown[]).filter((a): a is string => typeof a === 'string') : undefined;
    const envObj =
      body.env && typeof body.env === 'object' && !Array.isArray(body.env)
        ? (body.env as Record<string, unknown>)
        : undefined;
    const env: Record<string, string> | undefined = envObj
      ? Object.fromEntries(
          Object.entries(envObj).filter((kv): kv is [string, string] => typeof kv[1] === 'string'),
        )
      : undefined;
    const allowedAgentIds = Array.isArray(body.allowedAgentIds)
      ? (body.allowedAgentIds as unknown[]).filter((a): a is string => typeof a === 'string')
      : undefined;
    const newServer: MCPServerEntry = {
      name,
      command,
      enabled: true,
      ...(args && args.length > 0 ? { args } : {}),
      ...(env && Object.keys(env).length > 0 ? { env } : {}),
      ...(allowedAgentIds && allowedAgentIds.length > 0 ? { allowedAgentIds } : {}),
    };
    const updated = [...current, newServer];
    cm.setConfig('agentSettings', { ...(cm.getAgentSettings() as unknown as Record<string, unknown>), mcpServers: updated }, 'agent');
    await audit(req, 'mcp.add', name, command);
    sendJson(res, 200, { ok: true, server: newServer });
  } catch (err) {
    sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
  }
}

export async function handleRemoveMCP(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
  try {
    const cm = getConfigManager();
    const current = getMCPServers(cm);
    const filtered = current.filter((s) => s.name !== name);
    if (filtered.length === current.length) {
      sendError(res, 404, 'mcp_not_found', `MCP server "${name}" not found`);
      return;
    }
    cm.setConfig(
      'agentSettings',
      { ...(cm.getAgentSettings() as unknown as Record<string, unknown>), mcpServers: filtered },
      'agent',
    );
    await audit(req, 'mcp.remove', name);
    sendJson(res, 200, { ok: true, removed: name });
  } catch (err) {
    sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
  }
}

export async function handleAssignMCP(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch (err) {
    sendError(res, 400, 'invalid_request', err instanceof Error ? err.message : String(err));
    return;
  }
  try {
    const cm = getConfigManager();
    const current = getMCPServers(cm);
    const idx = current.findIndex((s) => s.name === name);
    if (idx === -1) {
      sendError(res, 404, 'mcp_not_found', `MCP server "${name}" not found`);
      return;
    }
    const updatedServer = { ...current[idx] };
    const allowedAgentIds = Array.isArray(body.allowedAgentIds)
      ? (body.allowedAgentIds as unknown[]).filter((a): a is string => typeof a === 'string')
      : [];
    if (allowedAgentIds.length > 0) {
      updatedServer.allowedAgentIds = allowedAgentIds;
    } else {
      delete updatedServer.allowedAgentIds;
    }
    const updatedServers = [...current];
    updatedServers[idx] = updatedServer;
    cm.setConfig(
      'agentSettings',
      { ...(cm.getAgentSettings() as unknown as Record<string, unknown>), mcpServers: updatedServers },
      'agent',
    );
    await audit(req, 'mcp.assign', name, allowedAgentIds.join(','));
    sendJson(res, 200, {
      ok: true,
      server: name,
      allowedAgentIds: allowedAgentIds.length > 0 ? allowedAgentIds : 'all',
    });
  } catch (err) {
    sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
  }
}