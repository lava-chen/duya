/**
 * electron/cli/handlers/skillWrite.ts
 *
 * CLI API write handlers for skill enable / disable. Phase 7.
 *
 * Only low-risk reversible writes are allowed. The override is
 * applied to the name-scoped `skillEnabledOverrides` setting; the
 * audit log is recorded by the main process.
 */

import * as http from 'http';
import { getConfigManager } from '../../config/manager';
import { getJsonSetting, setJsonSetting } from '../../db/index';
import { appendAuditEvent, type AuditEvent } from '../../services/controlPlaneAudit';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  type SkillListItem,
  type SkillInfoItem,
} from '../../../packages/agent/src/skills/skillService.js';

const SKILL_ENABLED_OVERRIDES_KEY = 'skillEnabledOverrides';
type SkillEnabledOverrides = Record<string, boolean>;

function getUserDataDir(): string {
  // Match the convention used by skills-handlers.ts. Dev override
  // comes from DUYA_CLI_USER_DATA_DIR; production uses Electron's
  // app.getPath('userData').
  const envOverride = process.env.DUYA_CLI_USER_DATA_DIR;
  if (envOverride && envOverride.trim().length > 0) return envOverride;
  // The Electron process has app available; default to DUYA path
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return app.getPath('userData');
    }
  } catch {
    // not in electron context
  }
  // Fallback to ~/.duya
  return join(homedir(), '.duya');
}

function getOverrides(): SkillEnabledOverrides {
  try {
    return getJsonSetting<SkillEnabledOverrides>(SKILL_ENABLED_OVERRIDES_KEY, {});
  } catch {
    return {};
  }
}

function writeOverrides(next: SkillEnabledOverrides): void {
  setJsonSetting(SKILL_ENABLED_OVERRIDES_KEY, next);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * Build a DTO mirroring the service list DTO. We re-derive the
 * enabled state from the new override value.
 */
function buildEnabledDTO(
  id: string,
  name: string,
  source: 'bundled' | 'user' | 'plugin',
  sourceId: string | undefined,
  enabled: boolean,
): SkillListItem {
  return { id, name, source, ...(sourceId ? { sourceId } : {}), enabled };
}

/**
 * Apply the override for a single skill id and write the audit
 * log entry. Returns the new effective state.
 */
async function applyOverride(
  id: string,
  enabled: boolean,
  correlationId: string | undefined,
): Promise<{ ok: true; item: SkillListItem } | { ok: false; reason: string }> {
  // Validate id format: bundled:*, user:*, plugin:*:*
  const idMatch = id.match(/^(bundled|user|plugin):/);
  if (!idMatch) {
    return { ok: false, reason: 'invalid id format' };
  }

  const current = getOverrides();
  const next: SkillEnabledOverrides = { ...current };
  if (enabled) {
    // enable = remove the override (default is enabled)
    delete next[id];
  } else {
    // disable = set to false
    next[id] = false;
  }
  writeOverrides(next);

  // Derive the canonical name (last component after `:`)
  const name = id.split(':').pop() ?? id;
  const source = idMatch[1] as 'bundled' | 'user' | 'plugin';
  const sourceId = source === 'plugin' ? id.split(':')[1] : undefined;

  // Audit
  const event: AuditEvent = {
    kind: enabled ? 'skill.enable' : 'skill.disable',
    id,
    ts: Date.now(),
    invokedBy: 'cli',
    ...(correlationId ? { correlationId } : {}),
  };
  await appendAuditEvent(getUserDataDir(), event);

  return {
    ok: true,
    item: buildEnabledDTO(id, name, source, sourceId, enabled),
  };
}

export async function handleEnableSkill(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
  correlationId: string | undefined,
): Promise<void> {
  const r = await applyOverride(id, true, correlationId);
  if (!r.ok) {
    sendJson(res, 400, { error: { code: 'invalid_id', message: r.reason } });
    return;
  }
  sendJson(res, 200, { skill: r.item });
}

export async function handleDisableSkill(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
  correlationId: string | undefined,
): Promise<void> {
  const r = await applyOverride(id, false, correlationId);
  if (!r.ok) {
    sendJson(res, 400, { error: { code: 'invalid_id', message: r.reason } });
    return;
  }
  sendJson(res, 200, { skill: r.item });
}