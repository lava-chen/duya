/** Refresh directory-scoped skills before exposing the new execution context. */
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { loadSkills, getSkillRegistry, getAgentSkillDirectory, clearConditionalSkills } from '../skills/index.js';
import { pluginDb, settingDb } from '../worker-db-client.js';

export async function refreshLocationSkills(cwd: string, sessionId?: string): Promise<void> {
  const plugins = await pluginDb.registryList() as Array<{ enabled?: unknown; installPath?: unknown }>;
  const overrides = await settingDb.getJson<Record<string, boolean>>('skillEnabledOverrides', {});
  const additionalPaths = plugins.filter((entry) => entry.enabled === true && typeof entry.installPath === 'string')
    .map((entry) => path.join(entry.installPath as string, 'skills')).filter((directory) => existsSync(directory));
  const registry = getSkillRegistry();
  for (const skill of registry.list()) if (skill.source === 'project') registry.unregister(skill.name);
  clearConditionalSkills();
  await loadSkills(cwd, { syncBundled: false, additionalPaths,
    ...(sessionId?.startsWith('bot:') ? { agentSkillsDir: getAgentSkillDirectory(sessionId.slice(4)) } : {}) });
  for (const [name, enabled] of Object.entries(overrides ?? {})) {
    if (enabled === false && registry.get(name)?.source !== 'system') registry.unregister(name);
  }
}
