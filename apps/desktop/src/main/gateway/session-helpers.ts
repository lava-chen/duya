/**
 * session-helpers.ts — Gateway session write adapters for the core store.
 *
 * Gateway message-bus handlers previously wrote `chat_sessions` rows via raw
 * SQL `INSERT ... ON CONFLICT DO UPDATE`. These helpers route session writes
 * through the authenticated Host Session API, preserving the upsert semantics
 * (insert if missing, sync workspace + permission profile if present).
 *
 * See plan 328 Phase 4 Task 1.
 */

import type { HostSessionPatch, HostSessionRecord } from '@duya/agent-protocol';
import { getDesktopHostSessionApi } from '../cli/desktop-host-api';

/**
 * Gateway (IM channels: Feishu/WeChat/Telegram/etc.) sessions use
 * permission_mode='auto' — the workspace-trust model (WorkBuddy-style:
 * allow within the workspace, gate workspace escapes via the classifier,
 * hardline-catastrophic ops always denied). Desktop settings.permissionMode
 * is intentionally ignored so a desktop user switching to bypass cannot
 * widen IM-channel permissions. Gateway auth is enforced via platform
 * whitelist / pairing.
 */
const GATEWAY_PERMISSION_PROFILE = 'auto';

/**
 * Extension keys stored in `sessions.extensions` that map to top-level
 * columns in the old `chat_sessions` table. Kept in sync with the
 * SESSION_EXTENSION_KEYS list in core-db-adapters.ts.
 */
const SESSION_EXTENSION_KEYS = new Set([
  'system_prompt',
  'conductor_mode_enabled',
  'conductor_canvas_id',
  'context_summary',
  'context_summary_updated_at',
  'source',
]);

type MutableHostSessionPatch = {
  -readonly [Key in keyof HostSessionPatch]?: HostSessionPatch[Key];
};

/**
 * Create or sync a gateway session record in the core store.
 *
 * Mirrors the old `INSERT INTO chat_sessions ... ON CONFLICT(id) DO UPDATE
 * SET working_directory = excluded.working_directory, permission_profile =
 * excluded.permission_profile, updated_at = excluded.updated_at` upsert:
 *  - If the session does not exist, create it with mode='chat',
 *    status='active', provider_id='env', permission_mode='auto'.
 *  - If it exists, only sync working_directory + permission_profile
 *    (preserving the existing title and metadata).
 *
 * `system_prompt` (empty string for gateway sessions) is routed to
 * `extensions.system_prompt`. Workspace paths are registered with Host and
 * persisted as opaque workspace references.
 */
export async function createGatewaySessionRecord(
  sessionId: string,
  title: string,
  workingDirectory: string,
  platform: string,
): Promise<HostSessionRecord> {
  const api = getDesktopHostSessionApi();
  const workspace = workingDirectory.trim()
    ? await api.registerLocalDirectory(workingDirectory)
    : undefined;
  const existing = await api.get(sessionId, { includeAllSessions: true });
  if (existing) {
    // Upsert conflict path: sync workspace + permission profile only.
    const result = await api.update(sessionId, undefined, {
      ...(workspace ? { workspace } : { workspace: { state: 'legacy_unbound' } }),
      permissionMode: GATEWAY_PERMISSION_PROFILE,
    });
    if (result.updated) return result.session;
  } else {
    return api.create({
      id: sessionId,
      ...(workspace ? {
        workspaceId: workspace.workspaceId,
        workspaceRootId: workspace.rootId,
        workspaceRelativePath: workspace.relativePath,
      } : {}),
      title,
      projectName: '',
      status: 'active',
      mode: 'chat',
      permissionMode: GATEWAY_PERMISSION_PROFILE,
      providerId: 'env',
      extensions: {
        system_prompt: '',
        source: 'gateway',
        gateway_platform: platform,
      },
    });
  }

  // The row may have been deleted between the initial read and update.
  return api.create({
    id: sessionId,
    ...(workspace ? {
      workspaceId: workspace.workspaceId,
      workspaceRootId: workspace.rootId,
      workspaceRelativePath: workspace.relativePath,
    } : {}),
    title,
    projectName: '',
    status: 'active',
    mode: 'chat',
    permissionMode: GATEWAY_PERMISSION_PROFILE,
    providerId: 'env',
    extensions: {
      system_prompt: '',
      source: 'gateway',
      gateway_platform: platform,
    },
  });
}

/**
 * Update gateway session metadata via the core store.
 *
 * Standard snake_case columns (title, working_directory, permission_profile,
 * project_name, status, model, mode, etc.) are routed to `sessions.update`.
 * Extension-bound fields (system_prompt, conductor_*, context_summary,
 * source) are routed to `sessions.setExtension` one key at a time.
 */
export async function updateGatewaySessionMeta(
  sessionId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const api = getDesktopHostSessionApi();
  const patch: MutableHostSessionPatch = {};
  const extensions: Record<string, string | number | boolean | null> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (SESSION_EXTENSION_KEYS.has(key)) {
      if (
        value === null || typeof value === 'string' || typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
      ) {
        extensions[key] = value;
      } else {
        throw new TypeError(`Unsupported gateway session extension value: ${key}`);
      }
    } else if (key === 'working_directory') {
      if (typeof value !== 'string') throw new TypeError('working_directory must be a string');
      patch.workspace = value.trim()
        ? await api.registerLocalDirectory(value)
        : { state: 'legacy_unbound' };
    } else if (key === 'permission_profile') {
      if (value !== 'default' && value !== 'auto' && value !== 'full_access') {
        throw new TypeError('permission_profile is not a supported session permission mode');
      }
      patch.permissionMode = value;
    } else if (key === 'project_name') {
      if (typeof value !== 'string') throw new TypeError('project_name must be a string');
      patch.projectName = value;
    } else if (key === 'status') {
      if (typeof value !== 'string') throw new TypeError('status must be a string');
      patch.status = value;
    } else if (key === 'model') {
      if (typeof value !== 'string') throw new TypeError('model must be a string');
      patch.model = value;
    } else if (key === 'title') {
      if (typeof value !== 'string') throw new TypeError('title must be a string');
      patch.title = value;
    } else if (key === 'mode') {
      if (typeof value !== 'string') throw new TypeError('mode must be a string');
      patch.mode = value;
    } else if (key === 'provider_id') {
      if (typeof value !== 'string') throw new TypeError('provider_id must be a string');
      patch.providerId = value;
    }
  }

  const update = {
    ...patch,
    ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
  };
  if (Object.keys(update).length > 0) {
    const result = await api.update(sessionId, undefined, update);
    if (!result.updated && result.reason === 'not_found') {
      throw new Error(`Gateway session not found: ${sessionId}`);
    }
  }
}
