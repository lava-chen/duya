import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  HostPluginAppInvocationApiV1,
  PluginAppInvocationBindInput,
  PluginAppInvocationInput,
} from '@duya/agent-protocol';
import { HostPluginAppInvocationApiError } from './local-plugin-app-invocation-api.js';

const ROOT = '/v1/local/plugin-app-invocations';
interface RoutePorts {
  readJson(request: IncomingMessage, response: ServerResponse): Promise<Record<string, unknown> | null>;
  sendJson(response: ServerResponse, status: number, body: unknown): void;
}

/** Registered after the Host's bearer-token and no-Origin checks. */
export async function routePluginAppInvocations(
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  api: HostPluginAppInvocationApiV1 | undefined,
  ports: RoutePorts,
): Promise<void> {
  const send = (status: number, body: unknown): void => ports.sendJson(response, status, body);
  if (!api) { send(503, { error: { code: 'plugin_app_invocation_authority_unavailable' } }); return; }
  try {
    if (url.pathname === `${ROOT}/bind` && request.method === 'POST') {
      const body = await ports.readJson(request, response);
      if (body === null) return;
      if (!only(body, ['pluginId', 'appId', 'instanceId', 'sessionId']) ||
          !id(body.pluginId) || !id(body.appId) || !id(body.instanceId) || !id(body.sessionId)) {
        send(400, { error: { code: 'invalid_plugin_app_binding_request' } }); return;
      }
      const binding = await api.bindPluginAppInvocation(body as unknown as PluginAppInvocationBindInput);
      send(201, { binding });
      return;
    }
    const match = new RegExp(`^${ROOT}/([^/]+)(?:/invoke)?$`).exec(url.pathname);
    if (!match) { send(404, { error: { code: 'not_found' } }); return; }
    let bindingId: string;
    try { bindingId = decodeURIComponent(match[1] ?? ''); }
    catch { send(400, { error: { code: 'invalid_plugin_app_binding_request' } }); return; }
    if (!id(bindingId) || bindingId.includes('/') || bindingId.includes('\\') || bindingId.includes('\0')) {
      send(400, { error: { code: 'invalid_plugin_app_binding_request' } }); return;
    }
    if (url.pathname.endsWith('/invoke') && request.method === 'POST') {
      const body = await ports.readJson(request, response);
      if (body === null) return;
      if (!only(body, ['nonce', 'toolId', 'arguments', 'requestId']) ||
          !id(body.nonce) || !id(body.toolId) || !record(body.arguments) ||
          (body.requestId !== undefined && !id(body.requestId))) {
        send(400, { error: { code: 'invalid_plugin_app_invocation_request' } }); return;
      }
      const result = await api.invokePluginAppTool({
        bindingId,
        nonce: body.nonce,
        toolId: body.toolId,
        arguments: body.arguments,
        ...(body.requestId === undefined ? {} : { requestId: body.requestId }),
      } as PluginAppInvocationInput);
      send(200, result);
      return;
    }
    if (url.pathname === `${ROOT}/${encodeURIComponent(bindingId)}` && request.method === 'DELETE') {
      const body = await ports.readJson(request, response);
      if (body === null) return;
      if (!only(body, ['nonce']) || !id(body.nonce)) {
        send(400, { error: { code: 'invalid_plugin_app_binding_request' } }); return;
      }
      send(200, { revoked: await api.revokePluginAppInvocation(bindingId, body.nonce) });
      return;
    }
    send(404, { error: { code: 'not_found' } });
  } catch (error) {
    if (error instanceof HostPluginAppInvocationApiError) {
      send(error.status, { error: { code: error.code } });
      return;
    }
    send(500, { error: { code: 'plugin_app_invocation_failed' } });
  }
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    value.trim() === value && !value.includes('\0');
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function only(body: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(body).every((key) => fields.includes(key));
}
