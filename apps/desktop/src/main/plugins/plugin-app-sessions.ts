/**
 * Plugin App session store — the trust fence for externally hosted mini apps.
 *
 * A session is minted by trusted launch code (never by the app itself) and
 * binds one installed Plugin App to one launched guest. The guest has no
 * preload and no direct channel to the Main process: it can only post a
 * message to the hosting renderer, which relays it here. Every relayed
 * call is re-checked against the session record before it reaches the Host,
 * so a guest can never widen its own authority:
 *
 *   - the guest never names the plugin, the App, or the chat session —
 *     those come from the session record created at launch;
 *   - the guest may only ask to bind, invoke one tool, or revoke;
 *   - the invocation always runs against the binding this session minted,
 *     so the guest cannot address another App's binding.
 */

import { randomBytes, randomUUID } from 'node:crypto';

/** One launched Plugin App guest. */
export interface PluginAppSession {
  /** Opaque handle the hosting renderer uses to address this session. */
  sessionId: string;
  /**
   * Freshness token. The hosting renderer echoes it on every relayed call;
   * a stale session (closed, or replaced by a newer launch) stops matching.
   */
  launchNonce: string;
  pluginId: string;
  appId: string;
  /** Durable App instance this session is bound to. */
  instanceId: string;
  /** Chat session the App acts in. Chosen at launch, never by the guest. */
  chatSessionId?: string;
  runtime: 'agent-run' | 'standalone';
  packageRevision?: string;
  createdAt: number;
}

/** The binding a session minted against the Host invocation API. */
export interface PluginAppSessionBinding {
  bindingId: string;
  nonce: string;
}

/** The complete set of things a guest is allowed to ask for. */
export type PluginAppGuestMessage =
  | { method: 'bind' }
  | { method: 'invoke'; toolId: string; arguments: Record<string, unknown> }
  | { method: 'revoke' };

export type PluginAppCallRejection =
  | 'unknown_session'
  | 'nonce_mismatch'
  | 'invalid_message'
  | 'not_bound';

export type PluginAppCallAuthorization =
  | { ok: true; message: PluginAppGuestMessage }
  | { ok: false; reason: PluginAppCallRejection };

const MAX_TOOL_ID_LENGTH = 128;
const MAX_ARGUMENT_KEYS = 64;

/**
 * Parse one guest message.
 *
 * Unknown methods, extra fields, and malformed payloads are refused rather
 * than coerced: the guest is untrusted input, so anything it sends is
 * either exactly one known shape or nothing.
 */
export function parsePluginAppGuestMessage(raw: unknown): PluginAppGuestMessage | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const message = raw as Record<string, unknown>;
  const method = message.method;

  if (method === 'bind' || method === 'revoke') {
    if (Object.keys(message).length !== 1) return null;
    return { method };
  }

  if (method === 'invoke') {
    if (Object.keys(message).sort().join(',') !== 'arguments,method,toolId') return null;
    const toolId = message.toolId;
    if (typeof toolId !== 'string' || toolId.length === 0 || toolId.length > MAX_TOOL_ID_LENGTH) {
      return null;
    }
    const args = message.arguments;
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
    const keys = Object.keys(args);
    if (keys.length > MAX_ARGUMENT_KEYS) return null;
    if (!keys.every((key) => key.length > 0 && key.length <= MAX_TOOL_ID_LENGTH)) return null;
    return { method: 'invoke', toolId, arguments: args as Record<string, unknown> };
  }

  return null;
}

/**
 * Check one relayed call against the session it claims to belong to.
 *
 * The session lookup and the nonce check are separate steps on purpose: a
 * missing session and a mismatched nonce are different failures, and only
 * the first one may be reported back to the guest.
 */
export function authorizePluginAppCall(
  session: PluginAppSession | null,
  launchNonce: unknown,
  raw: unknown,
): PluginAppCallAuthorization {
  if (!session) return { ok: false, reason: 'unknown_session' };
  if (typeof launchNonce !== 'string' || launchNonce.length === 0 || launchNonce !== session.launchNonce) {
    return { ok: false, reason: 'nonce_mismatch' };
  }
  const message = parsePluginAppGuestMessage(raw);
  if (!message) return { ok: false, reason: 'invalid_message' };
  return { ok: true, message };
}

/** In-memory registry of launched Plugin App sessions. */
export class PluginAppSessionStore {
  readonly #sessions = new Map<string, PluginAppSession>();
  readonly #bindings = new Map<string, PluginAppSessionBinding>();

  /** Mint a session for one launched App guest. */
  open(input: {
    pluginId: string;
    appId: string;
    instanceId: string;
    chatSessionId?: string;
    runtime?: 'agent-run' | 'standalone';
    packageRevision?: string;
  }): PluginAppSession {
    const session: PluginAppSession = {
      sessionId: randomUUID(),
      launchNonce: randomBytes(32).toString('base64url'),
      pluginId: input.pluginId,
      appId: input.appId,
      instanceId: input.instanceId,
      chatSessionId: input.chatSessionId,
      runtime: input.runtime ?? 'agent-run',
      packageRevision: input.packageRevision,
      createdAt: Date.now(),
    };
    this.#sessions.set(session.sessionId, session);
    return session;
  }

  get(sessionId: string): PluginAppSession | null {
    return this.#sessions.get(sessionId) ?? null;
  }

  all(): PluginAppSession[] {
    return [...this.#sessions.values()];
  }

  forPlugin(pluginId: string): PluginAppSession[] {
    return [...this.#sessions.values()].filter((session) => session.pluginId === pluginId);
  }

  /** Record the binding this session minted. */
  setBinding(sessionId: string, binding: PluginAppSessionBinding): boolean {
    if (!this.#sessions.has(sessionId)) return false;
    this.#bindings.set(sessionId, binding);
    return true;
  }

  bindingOf(sessionId: string): PluginAppSessionBinding | null {
    return this.#bindings.get(sessionId) ?? null;
  }

  /** Drop a session and the binding it minted. */
  close(sessionId: string): boolean {
    this.#bindings.delete(sessionId);
    return this.#sessions.delete(sessionId);
  }

  get size(): number {
    return this.#sessions.size;
  }
}
