import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  HostPluginAppGrantApiV1,
  PluginAppCapabilityTool,
} from '@duya/agent-protocol';
import { HostPluginAppGrantApiError } from './local-plugin-app-grant-api.js';

const ROOT = '/v1/local/plugin-app-grants';

interface RoutePorts {
  readJson(request: IncomingMessage, response: ServerResponse): Promise<Record<string, unknown> | null>;
  sendJson(response: ServerResponse, status: number, body: unknown): void;
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    value.trim() === value && !value.includes('\0');
}

function tools(value: unknown): value is PluginAppCapabilityTool[] {
  if (!Array.isArray(value) || value.length > 256) return false;
  return value.every((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const candidate = entry as { serverName?: unknown; toolName?: unknown };
    return Object.keys(entry).every((key) => key === 'serverName' || key === 'toolName') &&
      Object.keys(entry).length === 2 && id(candidate.serverName) && id(candidate.toolName);
  });
}

function only(body: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(body).every((key) => fields.includes(key));
}

/**
 * Registered after the Host's bearer-token and no-Origin checks, so only
 * privileged local callers reach it. Browser requests carry an Origin and
 * are refused before this route runs; a human approval UI is not implemented
 * by this endpoint.
 */
export async function routePluginAppGrants(
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  api: HostPluginAppGrantApiV1 | undefined,
  ports: RoutePorts,
): Promise<void> {
  const send = (status: number, body: unknown): void => ports.sendJson(response, status, body);
  if (!api) { send(503, { error: { code: 'plugin_app_grant_unavailable' } }); return; }
  try {
    if (url.pathname === ROOT && request.method === 'GET') {
      const pluginId = url.searchParams.get('pluginId');
      const appId = url.searchParams.get('appId');
      if (!id(pluginId) || !id(appId)) {
        send(400, { error: { code: 'invalid_plugin_app_grant_request' } });
        return;
      }
      send(200, { grants: await api.listPluginAppGrants({ pluginId, appId }) });
      return;
    }
    if (url.pathname === ROOT && request.method === 'POST') {
      const body = await ports.readJson(request, response);
      if (body === null) return;
      if (!only(body, ['pluginId', 'appId', 'capability', 'tools']) ||
          !id(body.pluginId) || !id(body.appId) || !id(body.capability) || !tools(body.tools)) {
        send(400, { error: { code: 'invalid_plugin_app_grant_request' } });
        return;
      }
      const grant = await api.grantPluginAppCapability({
        pluginId: body.pluginId,
        appId: body.appId,
        capability: body.capability,
        tools: body.tools,
      });
      send(200, { grant });
      return;
    }
    if (url.pathname === ROOT && request.method === 'DELETE') {
      const body = await ports.readJson(request, response);
      if (body === null) return;
      if (!only(body, ['pluginId', 'appId', 'capability']) ||
          !id(body.pluginId) || !id(body.appId) || !id(body.capability)) {
        send(400, { error: { code: 'invalid_plugin_app_grant_request' } });
        return;
      }
      send(200, {
        revoked: await api.revokePluginAppCapability({
          pluginId: body.pluginId,
          appId: body.appId,
          capability: body.capability,
        }),
      });
      return;
    }
    send(404, { error: { code: 'not_found' } });
  } catch (error) {
    if (error instanceof HostPluginAppGrantApiError) {
      send(error.status, { error: { code: error.code } });
      return;
    }
    send(500, { error: { code: 'plugin_app_grant_failed' } });
  }
}
