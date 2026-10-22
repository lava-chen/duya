/**
 * Plugin App host — launches an installed Plugin App as an externally
 * hosted mini app and brokers its calls into the Host plugin-app APIs.
 *
 * The guest is untrusted code: it has no preload, no `electronAPI`, and no
 * direct channel to the Main process. It can only post a message to the
 * renderer that hosts it, and that renderer relays the message here. This
 * module is where the message becomes an authorized Host call:
 *
 *   launch  → the trusted renderer names the plugin, the App and the chat
 *             session; this module resolves the App's entry file inside the
 *             installed package, binds a durable App instance and mints a
 *             session;
 *   call    → the session is looked up, the freshness token is checked and
 *             the message is parsed into one of exactly three shapes before
 *             anything reaches the Host.
 *
 * The App never names its own authority: the plugin, the App, the instance
 * and the chat session all come from the session record.
 */

import { BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PluginAppDefinition } from '@duya/plugin-core/apps/declarations';
import {
  PluginAppSessionStore,
  authorizePluginAppCall,
  type PluginAppGuestMessage,
} from './plugin-app-sessions';
import { getPluginManager } from './PluginManager';
import { readPluginManifest } from './manifest';
import {
  getDesktopHostPluginAppInstanceApi,
  getDesktopHostPluginAppInvocationApi,
} from '../cli/desktop-host-api';
import {
  approveStandaloneApp,
  bindStandaloneApp,
  closeStandaloneApp,
  invokeStandaloneApp,
  resolveStandaloneApp,
} from './standalone-app-runtime';

export type PluginAppHostError =
  | 'plugin_not_found'
  | 'plugin_disabled'
  | 'app_not_found'
  | 'entry_unavailable'
  | 'instance_unavailable'
  | 'host_unavailable'
  | 'unknown_session'
  | 'nonce_mismatch'
  | 'invalid_message'
  | 'not_bound'
  | 'bind_failed'
  | 'invoke_failed'
  | 'grant_denied';

export interface PluginAppOpenRequest {
  pluginId: string;
  appId: string;
  chatSessionId?: string;
}

export interface PluginAppOpenResult {
  ok: boolean;
  error?: PluginAppHostError;
  sessionId?: string;
  launchNonce?: string;
  entryUrl?: string;
}

export interface PluginAppCallRequest {
  sessionId: string;
  launchNonce: string;
  message: unknown;
}

export interface PluginAppCallResult {
  ok: boolean;
  error?: PluginAppHostError;
  result?: unknown;
}

const sessions = new PluginAppSessionStore();

/**
 * Resolve the App's entry file inside the installed package.
 *
 * The manifest parser already refuses an entry that escapes the package,
 * but this runs at launch time against whatever is on disk right now, so
 * the containment check is repeated here.
 */
function resolveAppEntry(installPath: string, app: PluginAppDefinition): string | null {
  let packageRealPath: string;
  try {
    packageRealPath = fs.realpathSync(installPath);
  } catch {
    return null;
  }

  let entryPath: string;
  try {
    entryPath = fs.realpathSync(path.resolve(packageRealPath, ...app.entry.split('/')));
  } catch {
    return null;
  }

  const relative = path.relative(packageRealPath, entryPath);
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  try {
    if (!fs.statSync(entryPath).isFile()) return null;
  } catch {
    return null;
  }
  return entryPath;
}

/** Find the installed, enabled plugin that declares this App. */
function findInstalledApp(
  pluginId: string,
  appId: string,
): { installPath: string; app: PluginAppDefinition } | null {
  for (const entry of getPluginManager().listInstalled()) {
    if (entry.id !== pluginId) continue;
    if (!entry.enabled) return null;
    let app: PluginAppDefinition | undefined;
    try {
      app = readPluginManifest(entry.installPath).apps?.find((candidate) => candidate.appId === appId);
    } catch {
      return null;
    }
    if (!app) return null;
    return { installPath: entry.installPath, app };
  }
  return null;
}

/**
 * Bind the App to a durable instance.
 *
 * An active instance for the same plugin and App is reused so the App keeps
 * its state across launches; a new one is minted only when there is none.
 */
async function resolveInstance(
  pluginId: string,
  appId: string,
  stateSchemaVersion: number,
): Promise<string | null> {
  try {
    const instanceApi = getDesktopHostPluginAppInstanceApi();
    const existing = await instanceApi.listPluginAppInstances(pluginId, appId);
    const reusable = existing.find(
      (instance) => instance.status === 'active' && instance.stateSchemaVersion === stateSchemaVersion,
    );
    if (reusable) return reusable.instanceId;
    const created = await instanceApi.createPluginAppInstance({ pluginId, appId, stateSchemaVersion });
    return created.instanceId;
  } catch {
    return null;
  }
}

async function handleOpen(request: PluginAppOpenRequest): Promise<PluginAppOpenResult> {
  if (typeof request?.pluginId !== 'string' || typeof request?.appId !== 'string') {
    return { ok: false, error: 'plugin_not_found' };
  }
  const found = findInstalledApp(request.pluginId, request.appId);
  if (!found) return { ok: false, error: 'app_not_found' };
  const standalone = found.app.runtime === 'standalone';
  if (!standalone && (typeof request.chatSessionId !== 'string' || request.chatSessionId.length === 0)) {
    return { ok: false, error: 'host_unavailable' };
  }

  const standaloneApp = standalone ? resolveStandaloneApp(request.pluginId, request.appId) : null;
  if (standalone && !standaloneApp) return { ok: false, error: 'app_not_found' };

  const entryPath = resolveAppEntry(found.installPath, found.app);
  if (!entryPath) return { ok: false, error: 'entry_unavailable' };
  if (standaloneApp && !(await approveStandaloneApp(standaloneApp))) return { ok: false, error: 'grant_denied' };

  const instanceId = await resolveInstance(
    request.pluginId,
    request.appId,
    found.app.stateSchemaVersion,
  );
  if (!instanceId) return { ok: false, error: 'instance_unavailable' };

  const session = sessions.open({
    pluginId: request.pluginId,
    appId: request.appId,
    instanceId,
    chatSessionId: request.chatSessionId,
    runtime: standalone ? 'standalone' : 'agent-run',
    packageRevision: standaloneApp?.revision,
  });

  return {
    ok: true,
    sessionId: session.sessionId,
    launchNonce: session.launchNonce,
    entryUrl: pathToFileURL(entryPath).href,
  };
}

async function dispatch(sessionId: string, message: PluginAppGuestMessage): Promise<PluginAppCallResult> {
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, error: 'unknown_session' };

  if (session.runtime === 'standalone') {
    if (!session.packageRevision) return { ok: false, error: 'bind_failed' };
    if (message.method === 'revoke') {
      await closeStandaloneApp(sessionId);
      return { ok: true, result: { revoked: true } };
    }
    if (message.method === 'bind') {
      try {
        const result = await bindStandaloneApp(
          sessionId, session.pluginId, session.appId, session.instanceId, session.packageRevision,
        );
        if (!sessions.get(sessionId)) {
          await closeStandaloneApp(sessionId);
          return { ok: false, error: 'unknown_session' };
        }
        return { ok: true, result };
      } catch {
        return { ok: false, error: 'bind_failed' };
      }
    }
    try {
      const result = await invokeStandaloneApp(sessionId, message.toolId, message.arguments);
      return result.ok ? { ok: true, result: result.result } : { ok: false, error: 'invoke_failed', result };
    } catch {
      return { ok: false, error: 'invoke_failed' };
    }
  }

  let invocationApi;
  try {
    invocationApi = getDesktopHostPluginAppInvocationApi();
  } catch {
    return { ok: false, error: 'host_unavailable' };
  }

  if (message.method === 'bind') {
    let binding;
    try {
      binding = await invocationApi.bindPluginAppInvocation({
        pluginId: session.pluginId,
        appId: session.appId,
        instanceId: session.instanceId,
        sessionId: session.chatSessionId!,
      });
    } catch {
      // The Host refuses a bind it cannot authorize (no active run, no
      // grant authority, manifest mismatch). The guest learns only that the
      // bind did not happen.
      return { ok: false, error: 'bind_failed' };
    }
    sessions.setBinding(sessionId, { bindingId: binding.bindingId, nonce: binding.nonce });
    return {
      ok: true,
      result: {
        bindingId: binding.bindingId,
        runId: binding.runId,
        // The App addresses a tool by its catalog id, and that id is not
        // something it can derive: the host reports the ones this binding
        // actually covers.
        tools: invocationApi.boundTools(binding.bindingId),
      },
    };
  }

  const binding = sessions.bindingOf(sessionId);
  if (!binding) return { ok: false, error: 'not_bound' };

  if (message.method === 'revoke') {
    const revoked = await invocationApi.revokePluginAppInvocation(binding.bindingId, binding.nonce);
    return { ok: true, result: { revoked } };
  }

  let outcome;
  try {
    outcome = await invocationApi.invokePluginAppTool({
      bindingId: binding.bindingId,
      nonce: binding.nonce,
      toolId: message.toolId,
      arguments: message.arguments,
    });
  } catch {
    return { ok: false, error: 'invoke_failed' };
  }
  if (!outcome.ok) return { ok: false, error: 'invoke_failed', result: outcome };
  return { ok: true, result: outcome.result };
}

async function handleCall(request: PluginAppCallRequest): Promise<PluginAppCallResult> {
  if (typeof request?.sessionId !== 'string') return { ok: false, error: 'unknown_session' };
  const authorized = authorizePluginAppCall(
    sessions.get(request.sessionId),
    request.launchNonce,
    request.message,
  );
  if (!authorized.ok) return { ok: false, error: authorized.reason };
  return dispatch(request.sessionId, authorized.message);
}

function handleClose(request: { sessionId?: string }): { ok: boolean } {
  if (typeof request?.sessionId !== 'string') return { ok: false };
  const session = sessions.get(request.sessionId);
  if (session?.runtime === 'standalone') void closeStandaloneApp(request.sessionId);
  const binding = sessions.bindingOf(request.sessionId);
  if (binding) {
    try {
      void getDesktopHostPluginAppInvocationApi().revokePluginAppInvocation(binding.bindingId, binding.nonce);
    } catch {
      // The Host may already be gone; the session is dropped either way.
    }
  }
  return { ok: sessions.close(request.sessionId) };
}

/** Register the Plugin App host channels. */
export function registerPluginAppHostHandlers(): void {
  ipcMain.handle('plugin-app:open', (_event, request: PluginAppOpenRequest) => handleOpen(request));
  ipcMain.handle('plugin-app:call', (_event, request: PluginAppCallRequest) => handleCall(request));
  ipcMain.handle('plugin-app:close', (_event, request: { sessionId?: string }) => handleClose(request));
}

/** Test seam: the live session registry. */
export function getPluginAppSessions(): PluginAppSessionStore {
  return sessions;
}

/** Invalidate every guest of a changed plugin and ask the host UI to reopen it. */
export function invalidatePluginAppSessions(pluginId: string): void {
  for (const session of sessions.forPlugin(pluginId)) {
    handleClose({ sessionId: session.sessionId });
  }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('plugin-app:changed', { pluginId });
  }
}
