import type { PluginAuditEvent } from './audit.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostPluginManagementApiV1 } from '@duya/agent-protocol/plugin-management';
import { PluginManagementError } from './management-api.js';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** Called behind the Host's bearer and Origin checks. */
export async function routePluginManagement(req: IncomingMessage, res: ServerResponse, url: URL,
  api: HostPluginManagementApiV1 | undefined,
  readJson: () => Promise<Record<string, unknown> | null>, audit?: (event: PluginAuditEvent) => Promise<void>): Promise<void> {
  if (!api) { json(res, 404, { error: { code: 'plugin_management_api_unavailable', message: 'This Host does not support plugin management' } }); return; }
  let auditId = '';
  let auditKind = 'plugin.mutation';
  const record = async (note: 'success' | 'failure') => {
    if (req.method !== 'POST' || !audit) return;
    const correlation = req.headers['x-correlation-id'];
    await audit({
      kind: auditKind, id: auditId, ts: Date.now(), invokedBy: 'cli', note,
      ...(typeof correlation === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(correlation) ? { correlationId: correlation } : {})
    });
  };
  try {
    const parts = url.pathname.split('/').filter(Boolean);
    const id = parts[2] ? decodeURIComponent(parts[2]) : '';
    auditId = /^[A-Za-z0-9@._-]{1,200}$/u.test(id) ? id : '<invalid>';
    const verb = parts[3] ?? id;
    auditKind = parts[1] === 'plugin-marketplaces' ? 'plugin.marketplace.' + (['remove', 'refresh'].includes(parts[3] ?? '') ? parts[3] : 'add')
      : 'plugin.' + (['install', 'enable', 'disable', 'uninstall', 'update'].includes(verb) ? verb : 'unsupported');
    let result: unknown;
    const marketplaceRoute = parts[1] === 'plugin-marketplaces';
    if (req.method === 'GET' && parts.length === 2) result = parts[1] === 'plugin-catalog' ? await api.catalog() : marketplaceRoute ? await api.listMarketplaces() : await api.list();
    else if (req.method === 'GET' && parts.length === 3) result = id === 'doctor' ? await api.doctor() : await api.info(id);
    else if (req.method === 'POST') {
      const body = await readJson();
      if (body === null) return;
      if (marketplaceRoute) {
        if (parts.length === 2 && typeof body.source === 'string' && body.source.length > 0 && body.source.length <= 4096) result = await api.addMarketplace(body.source);
        else if (parts.length === 4 && parts[3] === 'remove') result = await api.removeMarketplace(id);
        else if (parts.length === 4 && parts[3] === 'refresh') result = await api.refreshMarketplace(id);
      } else if (parts.length === 3 && id === 'install') {
        for (const key of ['pluginId', 'fromPath', 'scope', 'marketplace']) {
          if (body[key] !== undefined && (typeof body[key] !== 'string' || (body[key] as string).length > 4096)) throw new PluginManagementError('invalid_plugin_install', 'Invalid install arguments');
        }
        result = await api.install({
          pluginId: body.pluginId as string | undefined, fromPath: body.fromPath as string | undefined,
          scope: body.scope as string | undefined, marketplace: body.marketplace as string | undefined
        });
      } else if (parts.length === 4) {
        if (parts[3] === 'enable' || parts[3] === 'disable') result = await api.setEnabled(id, parts[3] === 'enable');
        else if (parts[3] === 'uninstall') {
          if (body.deleteData !== undefined && typeof body.deleteData !== 'boolean') throw new PluginManagementError('invalid_plugin_uninstall', 'deleteData must be boolean');
          result = await api.uninstall(id, body.deleteData === true);
        } else if (parts[3] === 'update') result = await api.update(id);
      }
    }
    if (result === undefined) json(res, 405, { error: { code: 'unsupported_plugin_operation', message: 'Unsupported plugin operation' } });
    else {
      if (result && typeof result === 'object' && 'plugin' in result) {
        const plugin = result.plugin;
        if (plugin && typeof plugin === 'object' && 'id' in plugin && typeof plugin.id === 'string') auditId = plugin.id;
      }
      await record('success'); json(res, 200, result);
    }
  } catch (error) {
    await record('failure');
    const known = error instanceof PluginManagementError;
    json(res, known ? error.status : 500, {
      error: {
        code: known ? error.code : 'plugin_operation_failed',
        message: known ? error.message : 'Plugin operation failed'
      }
    });
  }
}
