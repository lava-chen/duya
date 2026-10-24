/**
 * Plugin App host protocol — the wire between a hosted mini app and the
 * renderer that hosts it.
 *
 * The guest runs in an opaque-origin sandboxed iframe with no preload and no direct
 * channel to the Main process. It reaches its host with `postMessage`, and
 * the host relays every message into the Main process, which re-checks it
 * against the session before it reaches the Host.
 *
 * Guest → host:
 *   { channel: 'duya.plugin-app', documentToken, id, method: 'bind' | 'invoke' | 'revoke', toolId?, arguments? }
 *   { channel: 'duya.plugin-app', documentToken, method: 'ready' }
 *
 * Host → guest:
 *   { channel: 'duya.plugin-app', id, ok, result?, error? }
 *   { channel: 'duya.plugin-app', type: 'event', documentToken, surfaceId, eventName, payload }
 *
 * The guest sends `ready` after loading its document before it can receive
 * host events. Events are launched only to that frame and the current surface.
 *
 * The guest never names the plugin, the App, the instance or the chat
 * session: the host owns those, and the Main process re-derives them from
 * the session record.
 */

export const PLUGIN_APP_CHANNEL = "duya.plugin-app";

export type PluginAppGuestMethod = "bind" | "invoke" | "revoke";

export interface PluginAppGuestRequest {
  channel: typeof PLUGIN_APP_CHANNEL;
  /** Proves this request came from the launched package document, not a later navigation. */
  documentToken: string;
  id: string;
  method: PluginAppGuestMethod;
  toolId?: string;
  arguments?: Record<string, unknown>;
}

export interface PluginAppHostResponse {
  channel: typeof PLUGIN_APP_CHANNEL;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface PluginAppLaunch {
  sessionId: string;
  launchNonce: string;
  entryUrl: string;
  documentToken: string;
}

const DOCUMENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Extract the per-launch token from a trusted loopback asset URL. */
export function getPluginAppDocumentToken(entryUrl: string): string | null {
  if (!isPluginAppEntryUrl(entryUrl)) return null;
  const token = new URL(entryUrl).pathname.split("/", 2)[1];
  return token && DOCUMENT_TOKEN_PATTERN.test(token) ? token : null;
}

/** Accept only an asset URL served by the trusted loopback Plugin App host. */
export function isPluginAppEntryUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  try {
    const url = new URL(raw);
    return url.protocol === "http:"
      && url.hostname === "127.0.0.1"
      && url.port.length > 0
      && url.username.length === 0
      && url.password.length === 0
      && url.pathname.split("/").length >= 3
      && DOCUMENT_TOKEN_PATTERN.test(url.pathname.split("/", 2)[1] ?? "")
      && url.search.length === 0
      && url.hash.length === 0;
  } catch {
    return false;
  }
}

/** Narrow the untrusted value returned across the Plugin App IPC boundary. */
export function parsePluginAppCallResult(raw: unknown): {
  ok: boolean;
  result?: unknown;
  error?: string;
} | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.ok !== "boolean") return null;
  if (value.error !== undefined && typeof value.error !== "string") return null;
  return {
    ok: value.ok,
    ...(value.result !== undefined ? { result: value.result } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

const MAX_ID_LENGTH = 128;
const MAX_TOOL_ID_LENGTH = 128;
const MAX_ARGUMENT_KEYS = 64;

/**
 * Parse one guest request.
 *
 * A guest message is untrusted input: unknown methods, missing ids and
 * extra fields are refused rather than repaired, so a malformed message
 * never turns into a partially-understood call.
 */
export function parsePluginAppGuestRequest(
  raw: unknown,
  expectedDocumentToken: string,
): PluginAppGuestRequest | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const message = raw as Record<string, unknown>;
  if (message.channel !== PLUGIN_APP_CHANNEL) return null;
  if (message.documentToken !== expectedDocumentToken) return null;

  const id = message.id;
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) return null;

  const method = message.method;
  if (method === "bind" || method === "revoke") {
    return { channel: PLUGIN_APP_CHANNEL, documentToken: expectedDocumentToken, id, method };
  }

  if (method === "invoke") {
    const toolId = message.toolId;
    if (typeof toolId !== "string" || toolId.length === 0 || toolId.length > MAX_TOOL_ID_LENGTH) {
      return null;
    }
    const args = message.arguments;
    if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
    const keys = Object.keys(args);
    if (keys.length > MAX_ARGUMENT_KEYS) return null;
    if (!keys.every((key) => key.length > 0 && key.length <= MAX_TOOL_ID_LENGTH)) return null;
    return {
      channel: PLUGIN_APP_CHANNEL,
      documentToken: expectedDocumentToken,
      id,
      method,
      toolId,
      arguments: args as Record<string, unknown>,
    };
  }

  return null;
}

/** The message the host sends to the Main process for one guest request. */
export function toPluginAppHostMessage(request: PluginAppGuestRequest): Record<string, unknown> {
  if (request.method !== "invoke") return { method: request.method };
  return {
    method: "invoke",
    toolId: request.toolId,
    arguments: request.arguments ?? {},
  };
}

/** The Plugin App channel of the preload API, or null when unavailable. */
export function getPluginAppAPI() {
  const api = window.electronAPI?.pluginApp;
  if (!api) return null;
  return {
    open: (payload: { pluginId: string; appId: string; chatSessionId?: string; surfaceId?: string }) =>
      api.open(payload),
    call: (payload: { sessionId: string; launchNonce: string; message: unknown }) =>
      api.call(payload),
    close: (payload: { sessionId: string }) => api.close(payload),
    /** Refetch the surface directory after plugin install, enable, disable, remove, or App changes. */
    onChanged: (callback: (payload: { pluginId: string }) => void) => api.onChanged(callback),
  };
}
