import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  HostPluginAppInstanceApiV1,
  HostPluginAppInstanceCreateInput,
  HostPluginAppInstanceStatusInput,
  HostPluginAppInstanceWriteInput,
} from '@duya/agent-protocol';

const ROOT = '/v1/local/plugin-app-instances';
interface RoutePorts {
  readJson(request: IncomingMessage, response: ServerResponse): Promise<Record<string, unknown> | null>;
  sendJson(response: ServerResponse, status: number, body: unknown): void;
}

/** Called only after the Host's existing bearer and Origin checks. */
export async function routePluginAppInstances(
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  api: HostPluginAppInstanceApiV1 | undefined,
  ports: RoutePorts,
): Promise<void> {
  const send = (status: number, body: unknown): void => ports.sendJson(response, status, body);
  const bad = (): void => send(400, { error: { code: 'invalid_plugin_app_instance_request' } });
  if (!api) { send(404, { error: { code: 'plugin_app_instance_api_unavailable' } }); return; }
  if (url.pathname === ROOT) {
    if (request.method === 'GET') {
      const pluginId = url.searchParams.get('pluginId');
      const appId = url.searchParams.get('appId');
      if (!id(pluginId) || (appId !== null && !id(appId)) ||
          [...url.searchParams.keys()].some((key) => key !== 'pluginId' && key !== 'appId')) {
        bad(); return;
      }
      send(200, { instances: await api.listPluginAppInstances(pluginId, appId ?? undefined) });
      return;
    }
    if (request.method === 'POST') {
      const body = await ports.readJson(request, response);
      if (body === null) return;
      if (!keys(body, ['pluginId', 'appId', 'stateSchemaVersion', 'state']) ||
          !id(body.pluginId) || !id(body.appId) || !positive(body.stateSchemaVersion) ||
          (body.state !== undefined && !record(body.state))) { bad(); return; }
      send(201, { instance: await api.createPluginAppInstance(body as unknown as HostPluginAppInstanceCreateInput) });
      return;
    }
  }
  const match = /^\/v1\/local\/plugin-app-instances\/([^/]+)(?:\/(state|status))?$/.exec(url.pathname);
  let instanceId: string | undefined;
  try { instanceId = match?.[1] === undefined ? undefined : decodeURIComponent(match[1]); }
  catch { bad(); return; }
  if (!match || !id(instanceId) || instanceId.includes('/') || instanceId.includes('\\') || instanceId.includes('\0')) {
    send(404, { error: { code: 'not_found' } }); return;
  }
  if (match[2] === undefined && request.method === 'GET') {
    send(200, { instance: await api.getPluginAppInstance(instanceId) }); return;
  }
  if (request.method === 'POST' && (match[2] === 'state' || match[2] === 'status')) {
    const body = await ports.readJson(request, response);
    if (body === null) return;
    if (match[2] === 'state') {
      if (!keys(body, ['expectedRevision', 'expectedSchemaVersion', 'state']) ||
          !positive(body.expectedRevision) || !positive(body.expectedSchemaVersion) || !record(body.state)) {
        bad(); return;
      }
      send(200, await api.writePluginAppInstanceState(instanceId, body as unknown as HostPluginAppInstanceWriteInput));
      return;
    }
    if (!keys(body, ['expectedRevision', 'status']) || !positive(body.expectedRevision) ||
        typeof body.status !== 'string' ||
        !['active', 'disabled', 'revoked'].includes(body.status)) { bad(); return; }
    send(200, await api.setPluginAppInstanceStatus(instanceId, body as unknown as HostPluginAppInstanceStatusInput));
    return;
  }
  send(404, { error: { code: 'not_found' } });
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    value.trim() === value && !value.includes('\0');
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(body: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(body).every((key) => allowed.includes(key));
}
