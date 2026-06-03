/**
 * electron/cli/handlers/mcps.ts
 *
 * CLI API handlers for MCP read-only control plane. Both list and
 * info delegate to the shared `mcpService` so the GUI and CLI
 * server produce identical winner classifications.
 *
 * The candidates are sourced from the main-process collector
 * (`collectMainMCPCandidates`), which unifies bundled, plugin
 * manifest, legacy on-disk, agent settings, and settingsKv.
 */

import * as http from 'http';
import { collectMainMCPCandidates } from '../../agents/mcp/collect-main.js';
import {
  toMCPListDTO,
  toMCPInfoDTO,
  type MCPListItem,
  type MCPInfoItem,
} from '../../../packages/agent/src/mcp/mcpService.js';

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

export async function handleListMCPs(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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

export async function handleGetMCP(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
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