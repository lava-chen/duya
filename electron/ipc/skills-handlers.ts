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
import * as http from 'http';
import { homedir, platform as getPlatform, tmpdir } from 'os';
import extractZip from 'extract-zip';
import { getLogger, LogComponent } from '../logging/logger';
import { parseSkillFrontmatter, parseAllowedTools } from '../utils/skill-parser';
import { scanSkillFile, type SkillFinding } from '../../packages/agent/src/security/skillScanner.js';
import { getConfigStore } from '../config/store-instance';
import type { SkillConfigEntry } from '../config/schema';
import { getPluginManager } from '../plugins/PluginManager';
import { getAgentServerUrl } from '../services/agent-server-url';
import * as crypto from 'crypto';

type SkillEnabledOverrides = Record<string, boolean>;

function readSkillOverrides(): SkillEnabledOverrides {
  const config = getConfigStore().get();
  const overrides: SkillEnabledOverrides = {};
  for (const entry of config.skills ?? []) {
    if (entry && entry.enabled === false) {
      overrides[entry.name] = false;
    }
  }
  return overrides;
}

const PROVENANCE_MARKER_FILENAME = '.duya-origin.json';
const MANIFEST_FILENAME = '.bundled_manifest.json';

/**
 * Read the provenance marker for a skill directory. Returns the parsed
 * marker object if valid, otherwise null.
 */
function readOriginMarker(skillDir: string): { schemaVersion: number; origin: string; skillName: string } | null {
  const markerPath = path.join(skillDir, PROVENANCE_MARKER_FILENAME);
  try {
    if (!fs.existsSync(markerPath)) return null;
    const raw = fs.readFileSync(markerPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.schemaVersion === 1 &&
      typeof parsed.origin === 'string' &&
      typeof parsed.skillName === 'string'
    ) {
      return parsed as { schemaVersion: number; origin: string; skillName: string };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Recursively copy a directory, preserving sub-folders. The existing
 * provenance marker is intentionally skipped so the installer can write
 * its own.
 */
function copyDirRecursiveSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === PROVENANCE_MARKER_FILENAME) continue;

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursiveSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function notifyAgentServerSkillsReload(): Promise<void> {
  const url = await getAgentServerUrl();
  if (!url) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const reqObj = http.request(`${url}/plugins/reload`, { method: 'POST' }, (res) => {
        res.resume();
        resolve();
      });
      reqObj.on('error', reject);
      reqObj.setTimeout(2000, () => {
        reqObj.destroy();
        resolve();
      });
      reqObj.end();
    });
  } catch {
    // Agent server may not be running. Ignore.
  }
}

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
        skillId: string;
        description: string;
        category?: string;
        source?: string;
        sourceId?: string;
        enabled?: boolean;
        userInvocable?: boolean;
        whenToUse?: string;
        allowedTools?: string[];
        platforms?: string[];
        content: string;
        updatedAt: string;
        frontmatter: Record<string, unknown>;
        security?: {
          verdict: 'safe' | 'caution' | 'dangerous';
          findings: SkillFinding[];
          scanned: boolean;
        };
      }> = [];

      const loadedNames = new Set<string>();
      const logger = getLogger();
      const userSkillsDir = path.join(homedir(), '.duya', 'skills');

      // Provenance classification: read the manifest once. For each
      // top-level user-dir entry that lacks a .duya-origin.json marker,
      // we attempt a safe migration by comparing the directory's
      // content hash against the recorded bundled hash. A match means
      // the directory is the unmodified historical bundled copy;
      // we then write the marker so future runs are marker-based.
      //
      // This is the ONLY path that may classify a user-dir entry as
      // 'bundled' without a marker. Inference by directory name from
      // manifest is forbidden (Phase 3B-0.1 lock).
      let bundledManifest: Record<string, { hash: string; syncedAt: string }> = {};
      const manifestPath = path.join(userSkillsDir, MANIFEST_FILENAME);
      try {
        if (fs.existsSync(manifestPath)) {
          const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          if (raw && typeof raw === 'object' && raw.skills && typeof raw.skills === 'object') {
            bundledManifest = raw.skills as typeof bundledManifest;
          }
        }
      } catch {
        // Manifest unreadable; proceed with empty map (no migration)
      }

      /**
       * Compute a stable content hash for a skill directory. Hidden
       * files (including .duya-origin.json) are excluded so that
       * adding the marker does not change the hash. This is required
       * for the safe-migration path to recognise pre-existing bundled
       * copies.
       */
      const hashSkillDir = (dir: string): string => {
        const hashes: string[] = [];
        const walk = (current: string) => {
          const entries = fs.readdirSync(current, { withFileTypes: true });
          for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (e.name.startsWith('.')) continue;
            const p = path.join(current, e.name);
            if (e.isFile()) {
              const buf = fs.readFileSync(p);
              hashes.push(`${e.name}:${crypto.createHash('md5').update(buf).digest('hex')}`);
            } else if (e.isDirectory()) {
              const subHashes: string[] = [];
              const w = (cc: string) => {
                for (const ee of fs.readdirSync(cc, { withFileTypes: true })) {
                  if (ee.name.startsWith('.')) continue;
                  const pp = path.join(cc, ee.name);
                  if (ee.isFile()) {
                    subHashes.push(`${ee.name}:${crypto.createHash('md5').update(fs.readFileSync(pp)).digest('hex')}`);
                  } else if (ee.isDirectory()) {
                    w(pp);
                  }
                }
              };
              w(p);
              hashes.push(`${e.name}/:${crypto.createHash('md5').update(subHashes.join('|')).digest('hex')}`);
            }
          }
        };
        walk(dir);
        return crypto.createHash('md5').update(hashes.join('|')).digest('hex');
      };

      /**
       * Read the provenance marker synchronously. Returns the parsed
       * marker object if valid, otherwise null.
       */
      const readSkillProvenanceSync = (skillDir: string): { schemaVersion: number; origin: 'bundled'; skillName: string } | null => {
        const markerPath = path.join(skillDir, PROVENANCE_MARKER_FILENAME);
        try {
          if (!fs.existsSync(markerPath)) return null;
          const raw = fs.readFileSync(markerPath, 'utf-8');
          const parsed = JSON.parse(raw);
          if (
            parsed &&
            typeof parsed === 'object' &&
            parsed.schemaVersion === 1 &&
            parsed.origin === 'bundled' &&
            typeof parsed.skillName === 'string' &&
            parsed.skillName.length > 0
          ) {
            return parsed;
          }
          return null;
        } catch {
          return null;
        }
      };

      /**
       * Resolve the effective source for a top-level user-dir entry.
       * Returns 'bundled' ONLY when:
       *   (a) the entry has a valid .duya-origin.json marker, OR
       *   (b) safe migration: no marker, but directory content hash
       *       exactly matches the bundled hash recorded in the manifest
       *       (and we then write the marker so future runs are fast).
       * Otherwise returns 'user' — this is the safe default.
       */
      const resolveUserDirSource = (skillName: string, skillDir: string): 'bundled' | 'user' => {
        // (a) marker-based classification
        const marker = readSkillProvenanceSync(skillDir);
        if (marker) return 'bundled';

        // (b) safe migration from manifest hash
        const manifestEntry = bundledManifest[skillName];
        if (manifestEntry && typeof manifestEntry.hash === 'string') {
          const currentHash = hashSkillDir(skillDir);
          if (currentHash === manifestEntry.hash) {
            // Safe migration: directory is the unmodified historical
            // bundled copy. Write the marker for future runs.
            const markerPath = path.join(skillDir, PROVENANCE_MARKER_FILENAME);
            try {
              fs.writeFileSync(
                markerPath,
                JSON.stringify(
                  { schemaVersion: 1, origin: 'bundled', skillName },
                  null,
                  2,
                ) + '\n',
                'utf-8',
              );
              logger.info(`Wrote provenance marker for historical bundled skill '${skillName}'`, undefined, LogComponent.Skills);
            } catch (e) {
              logger.warn(`Failed to write provenance marker for '${skillName}'`, { error: String(e) }, LogComponent.Skills);
            }
            return 'bundled';
          }
        }
        // No marker, hash mismatch (or no manifest entry) → user-sourced
        return 'user';
      };

      const loadSkillsFromDir = (baseDir: string, source: string, sourceId?: string, classify?: (name: string, dir: string) => string) => {
        if (!fs.existsSync(baseDir)) return;

        const entries = fs.readdirSync(baseDir);

        for (const entry of entries) {
          if (entry.startsWith('.')) continue;

          const entryPath = path.join(baseDir, entry);
          const stat = fs.statSync(entryPath);

          if (!stat.isDirectory()) continue;

          // Top-level entries under the user dir with a classifier get
          // their effective source re-evaluated (marker or migration).
          // Subcategory layout and non-user sources keep the caller's
          // source as-is.
          const isTopLevel = baseDir === userSkillsDir;
          const effectiveSource = isTopLevel && classify ? classify(entry, entryPath) : source;

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
                  skillId: skillEntry,
                  description: (frontmatter.description as string) || skillEntry,
                  category: entry,
                  source: effectiveSource,
                  sourceId,
                  userInvocable: frontmatter['user-invocable'] !== false,
                  whenToUse: frontmatter['when-to-use'] as string | undefined,
                  allowedTools: parseAllowedTools(frontmatter['allowed-tools']),
                  platforms,
                  content: markdownContent,
                  frontmatter,
                  skillRoot: skillPath,
                  updatedAt: skillStat.mtime.toISOString(),
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
                skillId: entry,
                description: (frontmatter.description as string) || entry,
                category: (frontmatter.category as string) || 'other',
                source: effectiveSource,
                sourceId,
                userInvocable: frontmatter['user-invocable'] !== false,
                whenToUse: frontmatter['when-to-use'] as string | undefined,
                allowedTools: parseAllowedTools(frontmatter['allowed-tools']),
                platforms,
                content: markdownContent,
                frontmatter,
                skillRoot: entryPath,
                  updatedAt: stat.mtime.toISOString(),
                  security: { verdict: verdict2, findings: findings2, scanned: true },
              });
              loadedNames.add(entry);
            } catch (error) {
              logger.error(`Failed to load skill ${entry}`, error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Skills);
            }
          }
        }
      };

      // Bundled skills are now installed on-demand via the plugin marketplace;
      // they are no longer auto-synced at startup. syncStatus is kept in the
      // unsynced state to preserve the return shape for downstream consumers.
      let syncStatus: {
        synced: boolean;
        added: string[];
        updated: string[];
        skipped: string[];
        removed: string[];
        error?: string;
      } = { synced: false, added: [], updated: [], skipped: [], removed: [] };

      // Load user skills
      if (fs.existsSync(userSkillsDir)) {
        logger.info('Loading user skills', { dir: userSkillsDir }, LogComponent.Skills);
        loadSkillsFromDir(userSkillsDir, 'user', undefined, resolveUserDirSource);
      }

      // Load project skills
      const projectSkillsDir = path.join(process.cwd(), '.duya', 'skills');
      if (fs.existsSync(projectSkillsDir) && projectSkillsDir !== userSkillsDir) {
        logger.info('Loading project skills', { dir: projectSkillsDir }, LogComponent.Skills);
        loadSkillsFromDir(projectSkillsDir, 'project');
      }

      // Load custom skills from configured skill_path
      const customSkillPath = getConfigStore().getByPath('agent.skill_path') as string | undefined;
      if (customSkillPath && fs.existsSync(customSkillPath)) {
        const normalizedCustomPath = path.normalize(customSkillPath);
        const normalizedUserDir = path.normalize(userSkillsDir);
        const normalizedProjectDir = path.normalize(projectSkillsDir);
        if (normalizedCustomPath !== normalizedUserDir && normalizedCustomPath !== normalizedProjectDir) {
          logger.info('Loading custom skills from skill_path', { dir: customSkillPath }, LogComponent.Skills);
          loadSkillsFromDir(customSkillPath, 'custom');
        }
      }

      // Load plugin skills (enabled plugins only)
      const pluginManager = getPluginManager();
      const enabledPlugins = pluginManager.listInstalled().filter(p => p.enabled);
      for (const plugin of enabledPlugins) {
        // Check install path first (cache copy may have skills)
        if (plugin.installPath) {
          const pluginSkillsDir = path.join(plugin.installPath, 'skills');
          if (fs.existsSync(pluginSkillsDir)) {
            loadSkillsFromDir(pluginSkillsDir, 'plugin', plugin.id);
          }
        }
      }

      // Also scan builtin plugin cache directories. The install cache
      // only contains plugin.json — the skills/ directory lives in the
      // builtin cache (~/.duya/plugins/cache/builtin/<id>/<version>/skills/).
      // This makes builtin plugin skills visible even before install.
      try {
        const { listBuiltinCachePlugins } = await import('../plugins/cache/builtin-sync.js');
        for (const candidate of listBuiltinCachePlugins()) {
          const skillsDir = path.join(candidate.root, 'skills');
          if (fs.existsSync(skillsDir)) {
            loadSkillsFromDir(skillsDir, 'plugin', candidate.id);
          }
        }
      } catch (e) {
        logger.warn('Failed to scan builtin plugin skills', { error: String(e) }, LogComponent.Skills);
      }

      const skillOverrides = readSkillOverrides();
      const skillsWithState = skills.map(skill => ({
        ...skill,
        enabled: skillOverrides[skill.name] !== false,
      }));

      logger.info(`Loaded ${skills.length} skills total`, undefined, LogComponent.Skills);
      return { success: true, skills: skillsWithState, syncStatus };
    } catch (error) {
      const logger = getLogger();
      logger.error('Failed to list skills', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Skills);
      return { success: false, error: String(error), skills: [], syncStatus: null };
    }
  });

  ipcMain.handle('skills:getEnabledOverrides', async () => {
    try {
      const overrides = readSkillOverrides();
      return { success: true, overrides };
    } catch (error) {
      const logger = getLogger();
      logger.error('Failed to get skill enabled overrides', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Skills);
      return { success: false, error: String(error), overrides: {} };
    }
  });

  ipcMain.handle('skills:setEnabled', async (_event, skillName: string, enabled: boolean) => {
    try {
      const store = getConfigStore();
      const without = (store.get().skills ?? []).filter((e) => e.name !== skillName);
      if (enabled) {
        store.set('skills', without);
      } else {
        store.set('skills', [...without, { name: skillName, enabled: false }]);
      }
      const next = readSkillOverrides();
      await notifyAgentServerSkillsReload();
      return { success: true, overrides: next };
    } catch (error) {
      const logger = getLogger();
      logger.error('Failed to set skill enabled state', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Skills);
      return { success: false, error: String(error) };
    }
  });

  // Get security bypass list
  ipcMain.handle('skills:getSecurityBypass', async () => {
    try {
      const bypassSkills = (getConfigStore().getByPath('agent.security_bypass_skills') as string[] | undefined) || [];
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
      const currentList = (getConfigStore().getByPath('agent.security_bypass_skills') as string[] | undefined) || [];

      let newList: string[];
      if (bypass) {
        if (currentList.includes(skillName)) {
          return { success: true, skills: currentList };
        }
        newList = [...currentList, skillName];
      } else {
        newList = currentList.filter(s => s !== skillName);
      }

      getConfigStore().set('agent.security_bypass_skills', newList);
      const logger = getLogger();
      logger.info(`Updated security bypass list: ${bypass ? 'added' : 'removed'} '${skillName}'`, undefined, LogComponent.Skills);
      return { success: true, skills: newList };
    } catch (error) {
      const logger = getLogger();
      logger.error('Failed to update security bypass list', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Skills);
      return { success: false, error: String(error) };
    }
  });

  // Upload a single SKILL.md or a packaged skill archive
  ipcMain.handle('skills:uploadSkill', async (_event, filePath: string) => {
    const logger = getLogger();
    let tempDir: string | undefined;

    try {
      if (typeof filePath !== 'string' || filePath.length === 0) {
        return { success: false, error: 'Invalid file path' };
      }

      const resolvedPath = path.resolve(filePath);
      if (!fs.existsSync(resolvedPath)) {
        return { success: false, error: `File not found: ${resolvedPath}` };
      }

      const stat = fs.statSync(resolvedPath);
      if (stat.isDirectory()) {
        return { success: false, error: 'Uploading directories directly is not supported' };
      }

      const ext = path.extname(resolvedPath).toLowerCase();
      const userSkillsDir = path.join(homedir(), '.duya', 'skills');
      fs.mkdirSync(userSkillsDir, { recursive: true });

      let sourceDir: string;
      let skillMdPath: string;
      let fallbackName: string;

      if (ext === '.md') {
        tempDir = fs.mkdtempSync(path.join(tmpdir(), 'duya-skill-upload-'));
        sourceDir = tempDir;
        skillMdPath = path.join(sourceDir, 'SKILL.md');
        fs.copyFileSync(resolvedPath, skillMdPath);
        fallbackName = path.basename(resolvedPath, ext);
      } else if (ext === '.zip' || ext === '.skill') {
        tempDir = fs.mkdtempSync(path.join(tmpdir(), 'duya-skill-upload-'));
        const extractDir = tempDir;
        await extractZip(resolvedPath, { dir: extractDir });

        const rootSkillMd = path.join(extractDir, 'SKILL.md');
        if (fs.existsSync(rootSkillMd)) {
          sourceDir = extractDir;
          skillMdPath = rootSkillMd;
          fallbackName = path.basename(resolvedPath, ext);
        } else {
          const entries = fs.readdirSync(extractDir, { withFileTypes: true });
          const candidate = entries.find(
            (e) => e.isDirectory() && fs.existsSync(path.join(extractDir, e.name, 'SKILL.md')),
          );

          if (!candidate) {
            return { success: false, error: 'No SKILL.md found in archive' };
          }

          sourceDir = path.join(extractDir, candidate.name);
          skillMdPath = path.join(sourceDir, 'SKILL.md');
          fallbackName = candidate.name;
        }
      } else {
        return { success: false, error: `Unsupported file type: ${ext || 'none'}` };
      }

      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const { frontmatter, content: markdownContent } = parseSkillFrontmatter(content);

      const findings = scanSkillFile(markdownContent, 'SKILL.md');
      const criticalFindings = findings.filter((f) => f.severity === 'critical');
      if (criticalFindings.length > 0) {
        const messages = criticalFindings
          .map((f) => `[${f.patternId}] ${f.description} (line ${f.line})`)
          .join('; ');
        logger.warn(
          'Skill upload rejected due to critical security findings',
          { filePath: resolvedPath, count: criticalFindings.length },
          LogComponent.Skills,
        );
        return { success: false, error: `Upload blocked: critical security findings detected: ${messages}` };
      }

      const rawSkillName =
        typeof frontmatter.name === 'string' && frontmatter.name.trim().length > 0
          ? frontmatter.name.trim()
          : fallbackName;

      const skillName = rawSkillName.replace(/[\\/]/g, '_');

      if (!skillName) {
        return { success: false, error: 'Could not determine skill name' };
      }

      const targetDir = path.join(userSkillsDir, skillName);
      const existingOrigin = readOriginMarker(targetDir);
      if (existingOrigin?.origin === 'bundled') {
        logger.warn(
          `Refusing to overwrite bundled skill '${skillName}'`,
          { targetDir },
          LogComponent.Skills,
        );
        return { success: false, error: `Cannot overwrite bundled skill '${skillName}'` };
      }

      logger.info(
        `Installing user skill '${skillName}'`,
        { source: resolvedPath, targetDir },
        LogComponent.Skills,
      );

      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
      fs.mkdirSync(targetDir, { recursive: true });

      copyDirRecursiveSync(sourceDir, targetDir);

      const markerPath = path.join(targetDir, PROVENANCE_MARKER_FILENAME);
      fs.writeFileSync(
        markerPath,
        JSON.stringify({ schemaVersion: 1, origin: 'user', skillName }, null, 2) + '\n',
        'utf-8',
      );

      await notifyAgentServerSkillsReload();
      logger.info(
        `User skill '${skillName}' installed successfully`,
        { targetDir },
        LogComponent.Skills,
      );
      return { success: true, skillName };
    } catch (error) {
      logger.error(
        'Failed to upload skill',
        error instanceof Error ? error : new Error(String(error)),
        undefined,
        LogComponent.Skills,
      );
      return { success: false, error: String(error) };
    } finally {
      if (tempDir) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup failures
        }
      }
    }
  });
}
