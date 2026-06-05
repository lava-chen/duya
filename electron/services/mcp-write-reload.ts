/**
 * mcp-write-reload.ts
 *
 * Plan 83b Phase 2 — central helper that notifies the agent server
 * after a MCP config write. Reused by GUI IPC handlers and CLI
 * control plane handlers so the two write paths converge on the
 * same reload semantics.
 *
 * Why a dedicated helper:
 *   - The agent server expects `POST /plugins/reload` to broadcast
 *     `reload:mcp` to all attached workers. Without this call, the
 *     agent runtime keeps the previous MCP list and ignores the
 *     new settingsKv/agentSettings write.
 *   - The helper is best-effort: a 2s timeout swallows network
 *     errors so a stopped agent server does not break the GUI/CLI
 *     write path.
 */

import * as http from 'http';

import { getAgentServerUrl } from '../ipc/plugin-handlers';

export async function notifyMcpConfigChanged(): Promise<void> {
  const url = await getAgentServerUrl();
  if (!url) return;
  try {
    await new Promise<void>((resolve) => {
      const reqObj = http.request(`${url}/plugins/reload`, { method: 'POST' }, (res) => {
        res.resume();
        resolve();
      });
      reqObj.on('error', () => resolve());
      reqObj.setTimeout(2000, () => {
        reqObj.destroy();
        resolve();
      });
      reqObj.end();
    });
  } catch {
    // Silently ignore - agent server may not be running.
  }
}
