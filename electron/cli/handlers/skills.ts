/**
 * electron/cli/handlers/skills.ts
 *
 * CLI API handlers for the skill control plane. Both list and
 * info delegate to the shared `skillService` so the GUI IPC and
 * CLI server always produce identical winner classifications.
 */

import * as http from 'http';
import { join } from 'node:path';
import { getPluginManager } from '../../plugins/PluginManager';
import { getConfigStore } from '../../config/store-instance';
import { getBundledSkillsDir } from '../../plugins/catalog';
import { ensureSystemSkillsSynced } from '../../skills/system-skills-gui';
import { getJsonSetting } from '../../db/index';
import {
  listSkillDTOs,
  getSkillInfoDTO,
  computeSkillId,
  effectivePrecedenceOf,
  type SkillListItem,
  type SkillInfoItem,
} from '../../../packages/agent/src/skills/skillService.js';

const SKILL_ENABLED_OVERRIDES_KEY = 'skillEnabledOverrides';
type SkillEnabledOverrides = Record<string, boolean>;

function getOverrides(): SkillEnabledOverrides {
  try {
    return getJsonSetting<SkillEnabledOverrides>(SKILL_ENABLED_OVERRIDES_KEY, {});
  } catch {
    return {};
  }
}

function getUserSkillsDir(): string {
  // Same convention as IPC skills handler: ~/.duya/skills (or dev override).
  const { homedir } = require('node:os') as typeof import('node:os');
  return join(homedir(), '.duya', 'skills');
}

function getProjectSkillsDirs(): string[] {
  // Same convention as the IPC skills handler: <cwd>/.agent/skills
  // (cross-agent standard) plus <cwd>/.duya/skills.
  const cwd = process.cwd();
  return [join(cwd, '.agent', 'skills'), join(cwd, '.duya', 'skills')];
}

function getCustomSkillDir(): string | undefined {
  try {
    return getConfigStore().getByPath('agent.skill_path') as string | undefined;
  } catch {
    return undefined;
  }
}

function getSystemSkillsDir(): string {
  // Read from the synced user-dir copy (same source as the GUI, plan 434).
  const userSkillsDir = getUserSkillsDir();
  ensureSystemSkillsSynced(userSkillsDir, getBundledSkillsDir());
  return join(userSkillsDir, '.system');
}

function buildArgs(overrides: Record<string, boolean>) {
  return {
    userSkillsDir: getUserSkillsDir(),
    projectSkillsDirs: getProjectSkillsDirs(),
    customSkillDir: getCustomSkillDir(),
    systemSkillsDir: getSystemSkillsDir(),
    pluginInstallPaths: getPluginInstallPaths(),
    overrides,
  };
}

function getPluginInstallPaths(): Record<string, string> {
  try {
    const pm = getPluginManager();
    const enabled = pm.listInstalled().filter((p) => p.enabled);
    const out: Record<string, string> = {};
    for (const p of enabled) {
      out[p.id] = p.installPath;
    }
    return out;
  } catch {
    return {};
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

export function handleListSkills(req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const skills: SkillListItem[] = listSkillDTOs(buildArgs(getOverrides()));
    sendJson(res, 200, { skills });
  } catch (err) {
    sendJson(res, 500, {
      error: {
        code: 'internal_error',
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

export function handleGetSkill(req: http.IncomingMessage, res: http.ServerResponse, id: string): void {
  try {
    const info: SkillInfoItem | null = getSkillInfoDTO({
      ...buildArgs(getOverrides()),
      id,
    });
    if (!info) {
      sendJson(res, 404, {
        error: {
          code: 'skill_not_found',
          message: `Skill '${id}' not found`,
        },
      });
      return;
    }
    sendJson(res, 200, { skill: info });
  } catch (err) {
    sendJson(res, 500, {
      error: {
        code: 'internal_error',
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

export { computeSkillId, effectivePrecedenceOf };