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
  /**
   * The renderer that hosts the guest frame.
   *
   * A session is only useful while that renderer lives: a reload or a crash
   * destroys the iframe and the session can never be addressed again. Absent
   * means "unknown host" (tests, headless launches) and is never reaped.
   */
  webContentsId?: number;
  createdAt: number;
}

/** The binding a session minted against the Host invocation API. */
export interface PluginAppSessionBinding {
  bindingId: string;
  nonce: string;
}

/** A removed session and what it held, so the caller can release both. */
export interface PluginAppSessionLease {
  session: PluginAppSession;
  binding: PluginAppSessionBinding | null;
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
    webContentsId?: number;
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
      webContentsId: input.webContentsId,
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

  /**
   * Remove a session and hand back everything it held.
   *
   * Callers release the binding and the document mount *after* the removal,
   * so the record has to come back out with the removal: reading it first and
   * deleting second lets an early return skip the release, and deleting first
   * and reading second finds nothing left to release.
   */
  take(sessionId: string): PluginAppSessionLease | null {
    const session = this.#sessions.get(sessionId);
    const binding = this.#bindings.get(sessionId) ?? null;
    this.#bindings.delete(sessionId);
    if (!session) return null;
    this.#sessions.delete(sessionId);
    return { session, binding };
  }

  /** Drop a session and the binding it minted. */
  close(sessionId: string): boolean {
    return this.take(sessionId) !== null;
  }

  /**
   * Drop every session whose hosting renderer is gone.
   *
   * A renderer that reloads or crashes takes its iframes with it but leaves
   * the sessions behind: nothing can address them any more, and each one still
   * holds a document mount and possibly a Host binding. Returns the ids it
   * dropped so the caller can release those artifacts.
   *
   * Sessions with no recorded host are skipped — a test seam must not be
   * reaped by a liveness check it never opted into.
   */
  reapDead(isAlive: (webContentsId: number) => boolean): PluginAppSessionLease[] {
    const dropped: PluginAppSessionLease[] = [];
    for (const session of [...this.#sessions.values()]) {
      if (session.webContentsId === undefined) continue;
      if (isAlive(session.webContentsId)) continue;
      const lease = this.take(session.sessionId);
      if (lease) dropped.push(lease);
    }
    return dropped;
  }

  /**
   * Keep at most `limit` sessions, oldest first.
   *
   * A hard ceiling, not a policy: it exists so a renderer that leaks launches
   * (a remount loop, a stuck reload) cannot grow the registry without bound.
   */
  evictOldest(limit: number): PluginAppSessionLease[] {
    if (this.#sessions.size <= limit) return [];
    const ordered = [...this.#sessions.values()].sort((left, right) => left.createdAt - right.createdAt);
    const evicted: PluginAppSessionLease[] = [];
    for (const session of ordered.slice(0, Math.max(0, this.#sessions.size - limit))) {
      const lease = this.take(session.sessionId);
      if (lease) evicted.push(lease);
    }
    return evicted;
  }

  get size(): number {
    return this.#sessions.size;
  }
}
