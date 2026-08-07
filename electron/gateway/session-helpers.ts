/**
 * session-helpers.ts — Gateway session write adapters for the core store.
 *
 * Gateway message-bus handlers previously wrote `chat_sessions` rows via raw
 * SQL `INSERT ... ON CONFLICT DO UPDATE`. These helpers route those writes
 * through `getCoreStores().sessions` (SessionStore), preserving the legacy
 * upsert semantics (insert if missing, sync workspace + permission profile
 * if present) and the legacy row shape returned to callers.
 *
 * See plan 328 Phase 4 Task 1.
 */

import { getCoreStores } from '../db/core-connection';
import { coreSessionToIpcRow } from '../ipc/core-db-adapters';
import type { SessionPatch } from '../db/core';

/**
 * Gateway (IM channels: Feishu/WeChat/Telegram/etc.) sessions always use
 * permission_mode='default'. Desktop settings.permissionMode is intentionally
 * ignored so a desktop user switching to bypass cannot widen IM-channel
 * permissions. Gateway auth is enforced via platform whitelist / pairing.
 */
const GATEWAY_PERMISSION_PROFILE = 'default';

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

/**
 * Create or sync a gateway session record in the core store.
 *
 * Mirrors the old `INSERT INTO chat_sessions ... ON CONFLICT(id) DO UPDATE
 * SET working_directory = excluded.working_directory, permission_profile =
 * excluded.permission_profile, updated_at = excluded.updated_at` upsert:
 *  - If the session does not exist, create it with mode='chat',
 *    status='active', provider_id='env', permission_mode='default'.
 *  - If it exists, only sync working_directory + permission_profile
 *    (preserving the existing title and metadata).
 *
 * `system_prompt` (empty string for gateway sessions) is routed to
 * `extensions.system_prompt`. Returns the persisted row in the legacy
 * `chat_sessions` shape, or null if the session could not be read back.
 */
export function createGatewaySessionRecord(
  sessionId: string,
  title: string,
  workingDirectory: string,
  platform: string,
): Record<string, unknown> | null {
  const { sessions } = getCoreStores();
  const existing = sessions.get(sessionId);
  if (existing) {
    // Upsert conflict path: sync workspace + permission profile only.
    sessions.update(sessionId, {
      workingDirectory,
      permissionMode: GATEWAY_PERMISSION_PROFILE,
    });
  } else {
    sessions.create({
      id: sessionId,
      title,
      workingDirectory,
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
  const row = sessions.get(sessionId);
  return row ? coreSessionToIpcRow(row) : null;
}

/**
 * Update gateway session metadata via the core store.
 *
 * Standard snake_case columns (title, working_directory, permission_profile,
 * project_name, status, model, mode, etc.) are routed to `sessions.update`.
 * Extension-bound fields (system_prompt, conductor_*, context_summary,
 * source) are routed to `sessions.setExtension` one key at a time.
 */
export function updateGatewaySessionMeta(
  sessionId: string,
  fields: Record<string, unknown>,
): void {
  const { sessions } = getCoreStores();
  const patch: SessionPatch = {};

  for (const [key, value] of Object.entries(fields)) {
    if (SESSION_EXTENSION_KEYS.has(key)) {
      sessions.setExtension(sessionId, key, value);
    } else if (key === 'working_directory') {
      patch.workingDirectory = value as string;
    } else if (key === 'permission_profile') {
      patch.permissionMode = value as string;
    } else if (key === 'project_name') {
      patch.projectName = value as string;
    } else if (key === 'status') {
      patch.status = value as string;
    } else if (key === 'model') {
      patch.model = value as string;
    } else if (key === 'title') {
      patch.title = value as string;
    } else if (key === 'mode') {
      patch.mode = value as string;
    } else if (key === 'provider_id') {
      patch.providerId = value as string;
    }
  }

  if (Object.keys(patch).length > 0) {
    sessions.update(sessionId, patch);
  }
}
