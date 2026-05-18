/**
 * ipc/skills-handlers.ts - Skills-related IPC handlers
 *
 * Handlers for:
 * - Skills listing and loading
 * - Security bypass management
 */

import { ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { homedir, platform as getPlatform } from 'os';
import { getLogger, LogComponent } from '../logging/logger';
import { getConfigManager } from '../config/manager';
import { parseSkillFrontmatter, parseAllowedTools } from '../utils/skill-parser';
import { scanSkillFile, type SkillFinding } from '../../packages/agent/src/security/skillScanner.js';

function isPlatformSupported(platforms?: string[]): boolean {
  if (!platforms || platforms.length === 0) return true;

  const currentPlatform = getPlatform();
  const platformMap: Record<string, string> = {
    darwin: 'macos',
    win32: 'windows',
    linux: 'linux',
  };

  const normalizedCurrent = platformMap[currentPlatform] || currentPlatform;

  return platforms.some(p => {
    const normalized = p.toLowerCase().trim();
    return normalized === normalizedCurrent ||
           (normalized === 'macos' && currentPlatform === 'darwin') ||
           (normalized === 'windows' && currentPlatform === 'win32');
  });
}

export function registerSkillsHandlers(): void {
  ipcMain.handle('skills:list', async () => {
    try {
      const skills: Array<{
        name: string;
        description: string;
        category?: string;
        source?: string;
        userInvocable?: boolean;
        whenToUse?: string;
        allowedTools?: string[];
        platforms?: string[];
        content: string;
        frontmatter: Record<string, unknown>;
        security?: {
          verdict: 'safe' | 'caution' | 'dangerous';
          findings: SkillFinding[];
          scanned: boolean;
        };
      }> = [];

      const loadedNames = new Set<string>();
      const logger = getLogger();

      const loadSkillsFromDir = (baseDir: string, source: string) => {
        if (!fs.existsSync(baseDir)) return;

        const entries = fs.readdirSync(baseDir);

        for (const entry of entries) {
          if (entry.startsWith('.')) continue;

          const entryPath = path.join(baseDir, entry);
          const stat = fs.statSync(entryPath);

          if (!stat.isDirectory()) continue;

          const descriptionPath = path.join(entryPath, 'DESCRIPTION.md');
          const isCategoryDir = fs.existsSync(descriptionPath);

          if (isCategoryDir) {
            const skillEntries = fs.readdirSync(entryPath);
            for (const skillEntry of skillEntries) {
              if (skillEntry.startsWith('.')) continue;

              const skillPath = path.join(entryPath, skillEntry);
              const skillStat = fs.statSync(skillPath);
              if (!skillStat.isDirectory()) continue;

              const skillMdPath = path.join(skillPath, 'SKILL.md');
              if (!fs.existsSync(skillMdPath)) continue;

              if (loadedNames.has(skillEntry)) continue;

              try {
                const content = fs.readFileSync(skillMdPath, 'utf-8');
                const { frontmatter, content: markdownContent } = parseSkillFrontmatter(content);

                const platforms = parseAllowedTools(frontmatter.platforms);
                if (!isPlatformSupported(platforms)) {
                  logger.info(`Skipping skill '${skillEntry}' - not supported on current platform`, undefined, LogComponent.Skills);
                  continue;
                }

                const findings = scanSkillFile(markdownContent, 'SKILL.md');
                const verdict: 'safe' | 'caution' | 'dangerous' = findings.some((f) => f.severity === 'critical')
                  ? 'dangerous'
                  : findings.some((f) => f.severity === 'high')
                  ? 'caution'
                  : 'safe';

                skills.push({
                  name: skillEntry,
                  description: (frontmatter.description as string) || skillEntry,
                  category: entry,
                  source,
                  userInvocable: frontmatter['user-invocable'] !== false,
                  whenToUse: frontmatter['when-to-use'] as string | undefined,
                  allowedTools: parseAllowedTools(frontmatter['allowed-tools']),
                  platforms,
                  content: markdownContent,
                  frontmatter,
                  security: { verdict, findings, scanned: true },
                });
                loadedNames.add(skillEntry);
              } catch (error) {
                logger.error(`Failed to load skill ${skillEntry}`, error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Skills);
              }
            }
          } else {
            const skillMdPath = path.join(entryPath, 'SKILL.md');
            if (!fs.existsSync(skillMdPath)) continue;

            if (loadedNames.has(entry)) continue;

            try {
              const content = fs.readFileSync(skillMdPath, 'utf-8');
              const { frontmatter, content: markdownContent } = parseSkillFrontmatter(content);

              const platforms = parseAllowedTools(frontmatter.platforms);
              if (!isPlatformSupported(platforms)) {
                logger.info(`Skipping skill '${entry}' - not supported on current platform`, undefined, LogComponent.Skills);
                continue;
              }

              const findings2 = scanSkillFile(markdownContent, 'SKILL.md');
              const verdict2: 'safe' | 'caution' | 'dangerous' = findings2.some((f) => f.severity === 'critical')
                ? 'dangerous'
                : findings2.some((f) => f.severity === 'high')
                ? 'caution'
                : 'safe';

              skills.push({
                name: entry,
                description: (frontmatter.description as string) || entry,
                category: (frontmatter.category as string) || 'other',
                source,
                userInvocable: frontmatter['user-invocable'] !== false,
                whenToUse: frontmatter['when-to-use'] as string | undefined,
                allowedTools: parseAllowedTools(frontmatter['allowed-tools']),
                platforms,
                content: markdownContent,
                frontmatter,
                security: { verdict: verdict2, findings: findings2, scanned: true },
              });
              loadedNames.add(entry);
            } catch (error) {
              logger.error(`Failed to load skill ${entry}`, error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Skills);
            }
          }
        }
      };

      const userSkillsDir = path.join(homedir(), '.duya', 'skills');
      let syncStatus: {
        synced: boolean;
        added: string[];
        updated: string[];
        skipped: string[];
        removed: string[];
        error?: string;
      } = { synced: false, added: [], updated: [], skipped: [], removed: [] };

      try {
        const { syncBundledSkills } = await import('../../packages/agent/src/skills/skillsSync.js');
        const syncResult = await syncBundledSkills();
        syncStatus = {
          synced: true,
          added: syncResult.added,
          updated: syncResult.updated,
          skipped: syncResult.skipped,
          removed: syncResult.removed,
        };
        if (syncResult.added.length > 0 || syncResult.updated.length > 0) {
          logger.info('Bundled skills synced to user directory', {
            added: syncResult.added,
            updated: syncResult.updated,
          }, LogComponent.Skills);
        }
      } catch (e) {
        logger.warn('Failed to sync bundled skills', { error: String(e) }, LogComponent.Skills);
        syncStatus = { synced: false, added: [], updated: [], skipped: [], removed: [], error: String(e) };
      }

      // Load user skills
      if (fs.existsSync(userSkillsDir)) {
        logger.info('Loading user skills', { dir: userSkillsDir }, LogComponent.Skills);
        loadSkillsFromDir(userSkillsDir, 'user');
      }

      // Load project skills
      const projectSkillsDir = path.join(process.cwd(), '.duya', 'skills');
      if (fs.existsSync(projectSkillsDir) && projectSkillsDir !== userSkillsDir) {
        logger.info('Loading project skills', { dir: projectSkillsDir }, LogComponent.Skills);
        loadSkillsFromDir(projectSkillsDir, 'project');
      }

      // Load custom skills from configured skill_path
      const configManager = getConfigManager();
      const customSkillPath = configManager.getConfig().skill_path;
      if (customSkillPath && fs.existsSync(customSkillPath)) {
        const normalizedCustomPath = path.normalize(customSkillPath);
        const normalizedUserDir = path.normalize(userSkillsDir);
        const normalizedProjectDir = path.normalize(projectSkillsDir);
        if (normalizedCustomPath !== normalizedUserDir && normalizedCustomPath !== normalizedProjectDir) {
          logger.info('Loading custom skills from skill_path', { dir: customSkillPath }, LogComponent.Skills);
          loadSkillsFromDir(customSkillPath, 'custom');
        }
      }

      logger.info(`Loaded ${skills.length} skills total`, undefined, LogComponent.Skills);
      return { success: true, skills, syncStatus };
    } catch (error) {
      const logger = getLogger();
      logger.error('Failed to list skills', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Skills);
      return { success: false, error: String(error), skills: [], syncStatus: null };
    }
  });

  // Get security bypass list
  ipcMain.handle('skills:getSecurityBypass', async () => {
    try {
      const configManager = getConfigManager();
      const bypassSkills = configManager.getConfig().securityBypassSkills || [];
      return { success: true, skills: bypassSkills };
    } catch (error) {
      const logger = getLogger();
      logger.error('Failed to get security bypass list', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Skills);
      return { success: false, error: String(error), skills: [] };
    }
  });

  // Update security bypass list
  ipcMain.handle('skills:setSecurityBypass', async (_event, skillName: string, bypass: boolean) => {
    try {
      const configManager = getConfigManager();
      const config = configManager.getConfig();
      const currentList = config.securityBypassSkills || [];

      let newList: string[];
      if (bypass) {
        if (currentList.includes(skillName)) {
          return { success: true, skills: currentList };
        }
        newList = [...currentList, skillName];
      } else {
        newList = currentList.filter(s => s !== skillName);
      }

      configManager.setConfig('securityBypassSkills', newList);
      const logger = getLogger();
      logger.info(`Updated security bypass list: ${bypass ? 'added' : 'removed'} '${skillName}'`, undefined, LogComponent.Skills);
      return { success: true, skills: newList };
    } catch (error) {
      const logger = getLogger();
      logger.error('Failed to update security bypass list', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Skills);
      return { success: false, error: String(error) };
    }
  });
}