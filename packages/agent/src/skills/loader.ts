/**
 * Skill Loader for duya Agent
 * Loads skills from filesystem directories
 * Adapted from claude-code-haha/src/skills/loadSkillsDir.ts
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { homedir, platform as getPlatform } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ToolUseContext } from '../types.js';
import type { PromptSkill, SkillArgument, SkillCategory, SkillSource, RequiredEnvVar } from './types.js';
import { getSkillRegistry } from './registry.js';
import { scanSkillFile, shouldAllowInstall, type SkillFinding } from '../security/skillScanner.js';
import { registerConditionalSkill, separateConditionalSkills } from './conditionalSkills.js';
import { normalizeRequiredEnvVars } from './envVarCollector.js';
import { parseSkillFrontmatter } from './frontmatter.js';
import { getRootSnapshotCache } from './rootSnapshotCache.js';
import { shouldSkipScanDir } from './scanFilter.js';
import { settingDb } from '../ipc/db-client.js';

const SKILL_ENABLED_OVERRIDES_KEY = 'skillEnabledOverrides';
type SkillEnabledOverrides = Record<string, boolean>;

/**
 * Directory names never scanned for skills — shared with fingerprintDir via
 * `scanFilter.ts` so discovery and snapshotting always agree on noise.
 */
// (rules live in ./scanFilter.js)

/**
 * Agent Skills spec limits (aligned with pi's discovery rules):
 * a skill name is at most 64 characters and its frontmatter description at
 * most 1024. Violations produce a loud diagnostic instead of a silent drop —
 * the skill still loads, but the log names the offender so authors can fix it.
 */
const MAX_SKILL_NAME_CHARS = 64;
const MAX_SKILL_DESCRIPTION_CHARS = 1024;

function validateSkillSpec(name: string, description: string, source: SkillSource): void {
  if (name.length > MAX_SKILL_NAME_CHARS) {
    console.warn(
      `[Skills] Diagnostic: skill name '${name.slice(0, 32)}…' (${source}) exceeds ${MAX_SKILL_NAME_CHARS} chars (${name.length}); rename the directory to comply with the Agent Skills spec`,
    );
  }
  if (description.length > MAX_SKILL_DESCRIPTION_CHARS) {
    console.warn(
      `[Skills] Diagnostic: skill '${name}' (${source}) description exceeds ${MAX_SKILL_DESCRIPTION_CHARS} chars (${description.length}); only the first 250 chars reach the model-facing catalog`,
    );
  }
}

/**
 * Check if the current platform matches the skill's supported platforms
 * @param platforms - Array of supported platforms from skill frontmatter
 * @returns true if skill should be loaded on current platform
 */
function isPlatformSupported(platforms?: string[]): boolean {
  if (!platforms || platforms.length === 0) {
    return true;
  }

  const currentPlatform = getPlatform();
  const platformMap: Record<string, string> = {
    'darwin': 'macos',
    'win32': 'windows',
    'linux': 'linux',
  };

  const normalizedCurrent = platformMap[currentPlatform] || currentPlatform;

  return platforms.some(p => {
    const normalized = p.toLowerCase().trim();
    return normalized === normalizedCurrent ||
           (normalized === 'macos' && currentPlatform === 'darwin') ||
           (normalized === 'windows' && currentPlatform === 'win32');
  });
}

const CATEGORY_MAP: Record<string, SkillCategory> = {
  'cognition': 'cognition',
  'agentic': 'agentic',
  'development': 'development',
  'research': 'research',
  'creative': 'creative',
  'productivity': 'productivity',
  'data-science': 'data-science',
  'automation': 'automation',
  'communication': 'communication',
  'media': 'media',
  'apple': 'apple',
  'mcp': 'mcp',
  'system': 'system',
  'other': 'other',
};

/**
 * Parse arguments from frontmatter
 */
function parseArguments(
  args: unknown,
): SkillArgument[] {
  if (!args) return [];
  if (Array.isArray(args)) {
    return args
      .filter((a): a is string | SkillArgument => typeof a === 'string' || typeof a === 'object')
      .map(a => (typeof a === 'string' ? { name: a } : a));
  }
  if (typeof args === 'string') {
    return args.split(',').map(s => ({ name: s.trim() })).filter(a => a.name);
  }
  return [];
}

/**
 * Parse allowed tools from frontmatter
 */
function parseAllowedTools(tools: unknown): string[] | undefined {
  if (!tools) return undefined;
  if (Array.isArray(tools)) {
    return (tools as unknown[]).map(String).filter(Boolean);
  }
  if (typeof tools === 'string') {
    return tools.split(',').map(s => s.trim()).filter(Boolean);
  }
  return undefined;
}

/**
 * Create a prompt skill from a skill directory
 */
async function createSkillFromDirectory(
  skillDir: string,
  skillName: string,
  source: SkillSource,
  inheritedCategory?: SkillCategory,
  securityBypassSkills?: string[],
  skipSecurityScan?: boolean,
): Promise<PromptSkill | null> {
  const skillFilePath = path.join(skillDir, 'SKILL.md');

  let content: string;
  try {
    content = await fs.readFile(skillFilePath, 'utf-8');
  } catch {
    return null;
  }

  // Parse frontmatter and content
  const { frontmatter, content: markdownContent } = parseSkillFrontmatter(content);

  // ── Security scan ─────────────────────────────────────────────────────
  // Scan SKILL.md for injection/exfiltration/destructive patterns
  // Skip security scan for bundled (built-in) skills - they are trusted
  // Also skip if user has explicitly chosen to bypass security for this skill
  // Also skip if global security scan is disabled via settings
  const isBypassed = securityBypassSkills?.includes(skillName) ?? false;
  let findings: ReturnType<typeof scanSkillFile> = [];
  if (source !== 'bundled' && source !== 'system' && !isBypassed && !skipSecurityScan) {
    findings = scanSkillFile(markdownContent, 'SKILL.md');
    if (findings.length > 0) {
      // Determine verdict from findings
      const verdict = findings.some((f) => f.severity === 'critical')
        ? 'dangerous'
        : findings.some((f) => f.severity === 'high')
        ? 'caution'
        : 'safe';

      const { allowed } = shouldAllowInstall(verdict, source);

      if (allowed === false) {
        console.warn(
          `[Security] Skill '${skillName}' blocked: ${findings.length} finding(s) — ${findings.map(f => f.patternId).join(', ')}`,
        );
        return null;
      }

      if (allowed === null) {
        console.warn(
          `[Security] Skill '${skillName}' requires confirmation: ${findings.length} finding(s) — ${findings.map(f => f.patternId).join(', ')}`,
        );
        // Still load but warn
      } else {
        console.warn(
          `[Security] Skill '${skillName}' has concerns: ${findings.length} finding(s) — ${findings.map(f => f.patternId).join(', ')}`,
        );
      }
    }
  } else if (isBypassed) {
    console.warn(
      `[Security] Skill '${skillName}' loaded with security bypass (user override)`,
    );
  }
  // ── End security scan ────────────────────────────────────────────────


  const allowedTools = parseAllowedTools(frontmatter['allowed-tools']);
  const arguments_ = parseArguments(frontmatter['arguments']);
  const userInvocable =
    frontmatter['user-invocable'] === false ? false : true;
  const whenToUse = frontmatter['when-to-use'] as string | undefined;
  const description = (frontmatter.description as string) || skillName;

  validateSkillSpec(skillName, description, source);

  const argumentHint = frontmatter['argument-hint'] as string | undefined;
  const model = frontmatter.model as string | undefined;
  const effort = frontmatter.effort as number | undefined;
  const context = frontmatter.context as 'inline' | 'fork' | undefined;
  const agent = frontmatter.agent as string | undefined;
  const paths = parseAllowedTools(frontmatter.paths);
  const categoryRaw = (frontmatter.category as string | undefined);
  const category = categoryRaw ? (CATEGORY_MAP[categoryRaw] ?? 'other') : (inheritedCategory ?? undefined);

  // Parse platforms from frontmatter
  const platforms = parseAllowedTools(frontmatter.platforms) as string[] | undefined;

  // Check platform compatibility - skip loading if not supported
  if (!isPlatformSupported(platforms)) {
    console.log(`[Skills] Skipping '${skillName}' - not supported on current platform`);
    return null;
  }

  // Parse required environment variables
  const requiredEnvVars = normalizeRequiredEnvVars(frontmatter);

  // Parse setup configuration
  const setup = frontmatter.setup as { help?: string; collect_secrets?: Array<{ env_var: string; prompt: string; provider_url?: string; secret?: boolean }> } | undefined;

  const skill: PromptSkill = {
    type: 'prompt',
    name: skillName,
    description,
    aliases: undefined,
    hasUserSpecifiedDescription: !!frontmatter.description,
    argumentHint,
    whenToUse,
    allowedTools,
    arguments: arguments_.length > 0 ? arguments_ : undefined,
    model,
    effort,
    source,
    disableModelInvocation: frontmatter['disable-model-invocation'] === true,
    userInvocable,
    isEnabled: undefined,
    isHidden: !userInvocable,
    skillRoot: skillDir,
    context,
    agent,
    category,
    paths,
    hooks: undefined,
    requiredEnvVars: requiredEnvVars.length > 0 ? requiredEnvVars : undefined,
    setup,
    isConditional: paths && paths.length > 0 ? true : undefined,
    async getPromptForCommand(args, _context): Promise<string> {
      let finalContent = `Base directory for this skill: ${skillDir}\n\n${markdownContent}`;

      // Substitute $ARGUMENTS
      if (args) {
        finalContent = finalContent.replace(/\$ARGUMENTS/g, args);
        // Also handle $0, $1, etc.
        const parsedArgs = args.split(/\s+/).filter(Boolean);
        for (let i = 0; i < parsedArgs.length; i++) {
          finalContent = finalContent.replace(
            new RegExp(`\\$${i}(?!\\w)`, 'g'),
            parsedArgs[i],
          );
        }
        // Handle named arguments
        if (arguments_?.length) {
          for (let i = 0; i < arguments_.length; i++) {
            const argName = arguments_[i]?.name;
            if (argName) {
              finalContent = finalContent.replace(
                new RegExp(`\\$${argName}(?!\\[\\w])`, 'g'),
                parsedArgs[i] || '',
              );
            }
          }
        }
      }

      // Process skill paths - Progressive Disclosure Level 3+
      // Convert relative paths to absolute paths for scripts/, references/, assets/
      finalContent = processSkillPaths(finalContent, skillDir);

      return finalContent;
    },
  };

  return skill;
}

/**
 * Read category description from DESCRIPTION.md
 */
async function readCategoryDescription(dirPath: string): Promise<string | undefined> {
  const descPath = path.join(dirPath, 'DESCRIPTION.md');
  try {
    const content = await fs.readFile(descPath, 'utf-8');
    const { frontmatter } = parseSkillFrontmatter(content);
    const description = frontmatter.description as string | undefined;
    return description?.trim();
  } catch {
    return undefined;
  }
}

/**
 * Shared cache-key inputs for a skill directory. Everything that changes
 * how a directory is interpreted belongs here: source stamps skill.source,
 * the scan toggles gate the security pass, and the bundled-name set
 * decides effectiveSource for synced copies. Disabled-name overrides are
 * applied AFTER loading (in loadSkills), so they need no key here.
 */
function buildSnapshotConfigKey(
  source: SkillSource,
  skipSecurityScan?: boolean,
  securityBypassSkills?: string[],
  bundledSkillNames?: Set<string>,
): string {
  return JSON.stringify([
    source,
    skipSecurityScan ?? false,
    [...(securityBypassSkills ?? [])].sort(),
    [...(bundledSkillNames ?? [])].sort(),
  ]);
}

/**
 * Resolve one child directory through the per-skill snapshot cache
 * (plan 445). Unchanged subtrees reuse the same PromptSkill object
 * references across loads; a changed skill rebuilds alone while its
 * siblings stay cached.
 */
async function resolveSkillDirCached(
  entryPath: string,
  entryName: string,
  source: SkillSource,
  inheritedCategory?: SkillCategory,
  securityBypassSkills?: string[],
  bundledSkillNames?: Set<string>,
  skipSecurityScan?: boolean,
): Promise<PromptSkill[]> {
  const configKey = buildSnapshotConfigKey(source, skipSecurityScan, securityBypassSkills, bundledSkillNames);
  return getRootSnapshotCache().get(entryPath, configKey, async () => {
    const skill = await createSkillFromDirectory(
      entryPath,
      entryName,
      source,
      inheritedCategory,
      securityBypassSkills,
      skipSecurityScan,
    );
    if (skill) return [skill];
    // Not a SKILL.md leaf — recurse as a (possibly nested-category) tree.
    // Propagate the entry-name-derived category (e.g. 'development') so
    // <root>/development/<skill> inherits it even though the nested walk
    // re-derives isCategoryDir from its own DESCRIPTION.md.
    const nestedParent = CATEGORY_MAP[entryName.toLowerCase()] ?? inheritedCategory;
    return loadSkillsFromDirectory(
      entryPath,
      source,
      nestedParent,
      securityBypassSkills,
      bundledSkillNames,
      skipSecurityScan,
    );
  });
}

/**
 * Load skills from a specific directory.
 *
 * If the directory has a DESCRIPTION.md, it's a category directory and
 * skills are loaded from subdirectories with category inherited from parent.
 * Each child directory is resolved through the per-skill snapshot cache
 * (plan 445): unchanged subtrees reuse the same PromptSkill object
 * references; the walk itself always runs so per-load cost stays O(entries)
 * plus O(changed skills).
 */
export async function loadSkillsFromDirectory(
  dirPath: string,
  source: SkillSource,
  parentCategory?: SkillCategory,
  securityBypassSkills?: string[],
  bundledSkillNames?: Set<string>,
  skipSecurityScan?: boolean,
): Promise<PromptSkill[]> {
  const skills: PromptSkill[] = [];

  let entries: string[];
  try {
    entries = await fs.readdir(dirPath);
  } catch {
    return skills;
  }

  const isCategoryDir = entries.some(e => e === 'DESCRIPTION.md');

  // If this is a category directory, read and register the category description
  if (isCategoryDir) {
    const categoryName = path.basename(dirPath);
    const categoryDescription = await readCategoryDescription(dirPath);
    if (categoryDescription) {
      getSkillRegistry().registerCategoryDescription(categoryName, categoryDescription, 'file');
    }
  }

  for (const entry of entries) {
    if (entry === 'DESCRIPTION.md') continue;
    // System-level skills (.system) are loaded exclusively from the bundled
    // directory via loadSystemSkills() (source 'system', security scan
    // skipped, always enabled). A synced copy under a user/project skills
    // directory must not be double-loaded here: it would be scanned as
    // 'user'/'project' source and could trip findings that only system
    // skills are trusted to skip.
    if (entry === '.system') continue;
    // Never descend into dependency/build/dot noise (see SKIP_SCAN_DIR_NAMES).
    if (shouldSkipScanDir(entry)) continue;

    const entryPath = path.join(dirPath, entry);

    let stat;
    try {
      stat = await fs.stat(entryPath);
    } catch {
      continue;
    }

    if (!stat.isDirectory()) continue;

    const inheritedCategory = isCategoryDir ? CATEGORY_MAP[entry.toLowerCase()] ?? parentCategory : parentCategory;

    // Determine the effective source for this skill
    // Bundled skills synced to user dir should be treated as 'bundled' to skip security scans
    const effectiveSource: SkillSource =
      (source === 'user' && bundledSkillNames?.has(entry)) ? 'bundled' : source;

    // Per-child snapshot resolution (plan 445): a SKILL.md leaf resolves to
    // [skill] or []; anything else recurses as a nested-category tree.
    const childSkills = await resolveSkillDirCached(
      entryPath,
      entry,
      effectiveSource,
      inheritedCategory,
      securityBypassSkills,
      bundledSkillNames,
      skipSecurityScan,
    );
    skills.push(...childSkills);
  }

  return skills;
}

/**
 * Skill load options
 */
export interface SkillLoadOptions {
  /** Additional custom skill directories to load from */
  additionalPaths?: string[];
  /** Whether to sync bundled skills to user directory (default: true) */
  syncBundled?: boolean;
  /** List of skill names to bypass security checks for */
  securityBypassSkills?: string[];
  /** Skip all security scanning (default: false). Controlled by securityScanEnabled setting */
  skipSecurityScan?: boolean;
}

async function loadDisabledSkillNamesFromSettings(): Promise<Set<string>> {
  try {
    const overridesRaw = await settingDb.getJson<SkillEnabledOverrides | null>(SKILL_ENABLED_OVERRIDES_KEY, {});
    if (!overridesRaw || typeof overridesRaw !== 'object') {
      return new Set();
    }
    return new Set(
      Object.entries(overridesRaw)
        .filter(([, enabled]) => enabled === false)
        .map(([name]) => name),
    );
  } catch {
    return new Set();
  }
}

/**
 * Get the default skill directories
 * Default: ~/.duya/skills (user) and, per project,
 * <cwd>/.duya/skills plus <cwd>/.agent/skills (the cross-agent standard).
 * Later entries win name collisions (duya's own dir is loaded last).
 */
export function getSkillDirectories(cwd: string): {
  user: string;
  project: string[];
} {
  return {
    user: path.join(homedir(), '.duya', 'skills'),
    project: [
      path.join(cwd, '.agent', 'skills'),
      path.join(cwd, '.duya', 'skills'),
    ],
  };
}

/**
 * Get the bundled skills directory path (ships with the agent package).
 *
 * In dev (tsc/ESM):    dist/skills/loader.js  ->  packages/agent/skills/
 * In dev (bundled):    bundle/entry.js         ->  packages/agent/skills/
 * In prod (bundled):   resources/agent-bundle/ ->  resources/agent/skills/
 */
export function getBundledSkillsDir(): string {
  try {
    const __filename = fileURLToPath(new URL(import.meta.url));
    const __dirname = path.dirname(__filename);

    const candidates = [
      // Dev ESM:          dist/skills/  ->  ../../skills   -> packages/agent/skills/
      // Prod bundled:     agent-bundle/ -> ../../skills    -> resources/skills/ (not found, skips)
      path.resolve(__dirname, '..', '..', 'skills'),
      // Prod bundled:     agent-bundle/ -> ../agent/skills -> resources/agent/skills/
      path.resolve(__dirname, '..', 'agent', 'skills'),
      // Dev bundled:      bundle/       -> ../skills       -> packages/agent/skills/
      // Legacy prod:      agent-bundle/ -> ../skills       -> resources/skills/
      path.resolve(__dirname, '..', 'skills'),
    ];

    for (const candidate of candidates) {
      if (fsSync.existsSync(candidate)) {
        return candidate;
      }
    }

    return candidates[0];
  } catch {
    const candidates = [
      path.resolve(process.cwd(), '..', 'skills'),
      path.resolve(process.cwd(), 'packages', 'agent', 'skills'),
    ];
    for (const candidate of candidates) {
      if (fsSync.existsSync(candidate)) {
        return candidate;
      }
    }
    return path.resolve(process.cwd(), 'packages', 'agent', 'skills');
  }
}

/**
 * Get the system-level skills directory (`<bundledSkillsDir>/.system`).
 *
 * System-level skills ship with the agent and are always loaded, regardless
 * of whether bundled sync is enabled or the user installed anything. They are
 * trusted (security scan skipped), cannot be disabled by user overrides, and
 * are not synced to the user directory (the leading dot is skipped by
 * `syncBundledSkills`). Modeled after Codex's `~/.codex/skills/.system/`.
 */
export function getSystemSkillsDir(): string {
  return path.join(getBundledSkillsDir(), '.system');
}

/**
 * Load system-level skills from `.system/` and register them directly.
 *
 * Called at the end of `loadSkills()` — after user/project skills and after
 * disabled-filtering — so a system skill always wins any name collision with
 * a user skill. System skills are trusted and must never be gated by the
 * `skillEnabledOverrides` filter or conditional activation.
 */
export async function loadSystemSkills(skipSecurityScan?: boolean): Promise<PromptSkill[]> {
  const systemDir = getSystemSkillsDir();
  const skills = await loadSkillsFromDirectory(
    systemDir,
    'system',
    undefined,
    undefined,
    undefined,
    skipSecurityScan,
  );

  for (const skill of skills) {
    getSkillRegistry().register(skill);
  }

  if (skills.length > 0) {
    console.log(`[Skills] Loaded ${skills.length} system skill(s)`);
  }

  return skills;
}

/**
 * Load skills from standard directories
 *
 * Design principle: All built-in skills are synced to ~/.duya/skills/ first,
 * then loaded from there. This ensures:
 * - Users can see and edit all skills (including built-in ones)
 * - Transparency: no hidden bundled skills
 * - User customization is respected (sync respects manifest)
 *
 * Load order:
 * 1. ~/.duya/skills/ (includes synced built-in skills + user-added skills)
 * 2. <cwd>/.duya/skills/ (project-level skills)
 * 3. Additional custom paths
 *
 * @param cwd - Current working directory
 * @param options - Optional skill load options including additional paths
 */
export async function loadSkills(cwd: string, options?: SkillLoadOptions): Promise<PromptSkill[]> {
  const { user, project } = getSkillDirectories(cwd);

  const allSkills: PromptSkill[] = [];
  const securityBypassSkills = options?.securityBypassSkills;

  // Get bundled skill names upfront so we can pass them to loadSkillsFromDirectory
  // This allows bundled skills synced to user dir to skip security scans
  let bundledSkillNames = new Set<string>();
  try {
    const { listBundledSkillNames } = await import('./skillsSync.js');
    const bundledNames = await listBundledSkillNames();
    bundledSkillNames = new Set(bundledNames);
  } catch (e) {
    console.warn('[Skills] Failed to get bundled skill names:', e);
  }

  // Sync bundled skills to user directory if needed
  // This copies bundled skills to ~/.duya/skills/ where users can see and edit them
  if (options?.syncBundled !== false) {
    try {
      const { syncBundledSkills } = await import('./skillsSync.js');
      const syncResult = await syncBundledSkills();
      if (syncResult.added.length > 0 || syncResult.updated.length > 0) {
        console.log('[Skills] Bundled skills synced:', {
          added: syncResult.added,
          updated: syncResult.updated,
        });
      }
    } catch (e) {
      console.warn('[Skills] Failed to sync bundled skills:', e);
    }
  }

  const skipSecurityScan = options?.skipSecurityScan ?? false;

  // Load all skills from user directory (~/.duya/skills/)
  // This includes synced built-in skills AND user-added skills
  // bundledSkillNames is passed so that synced bundled skills use source='bundled' to skip security scans
  const userSkills = await loadSkillsFromDirectory(user, 'user', undefined, securityBypassSkills, bundledSkillNames, skipSecurityScan);

  if (bundledSkillNames.size > 0) {
    console.log(`[Skills] ${bundledSkillNames.size} bundled skills loaded with security bypass`);
  }
  allSkills.push(...userSkills);

  // Load project-level skills (both the cross-agent standard and duya's own)
  for (const projectDir of project) {
    const projectSkills = await loadSkillsFromDirectory(projectDir, 'project', undefined, securityBypassSkills, bundledSkillNames, skipSecurityScan);
    allSkills.push(...projectSkills);
  }

  // Load skills from additional custom paths
  if (options?.additionalPaths) {
    for (const additionalPath of options.additionalPaths) {
      // Resolve relative paths against cwd
      const resolvedPath = path.isAbsolute(additionalPath)
        ? additionalPath
        : path.join(cwd, additionalPath);
      const additionalSkills = await loadSkillsFromDirectory(resolvedPath, 'user', undefined, securityBypassSkills, bundledSkillNames, skipSecurityScan);
      allSkills.push(...additionalSkills);
    }
  }

  const disabledSkillNames = await loadDisabledSkillNamesFromSettings();
  const effectiveSkills = disabledSkillNames.size > 0
    ? allSkills.filter((skill) => !disabledSkillNames.has(skill.name))
    : allSkills;

  // Separate unconditional and conditional skills
  const [unconditionalSkills, conditionalSkillsList] = separateConditionalSkills(effectiveSkills);

  // Register unconditional skills immediately
  for (const skill of unconditionalSkills) {
    getSkillRegistry().register(skill);
  }

  // Register conditional skills as pending (not activated yet)
  for (const skill of conditionalSkillsList) {
    registerConditionalSkill(skill);
    getSkillRegistry().register(skill);
  }

  // Log summary
  const conditionalCount = conditionalSkillsList.length;
  if (conditionalCount > 0) {
    console.log(`[Skills] ${conditionalCount} conditional skill(s) pending activation (matched by file paths)`);
  }

  const disabledCount = allSkills.length - effectiveSkills.length;
  if (disabledCount > 0) {
    console.log(`[Skills] Filtered ${disabledCount} disabled skill(s) from runtime`);
  }
  console.log(`[Skills] Loaded ${unconditionalSkills.length} unconditional + ${conditionalCount} conditional skills`);

  // System-level skills are always loaded, independent of sync config and
  // user overrides. Registered last so they win any name collision with a
  // user skill. They are not part of `effectiveSkills` (which went through
  // disabled filtering and conditional separation).
  const systemSkills = await loadSystemSkills(skipSecurityScan);

  return [...effectiveSkills, ...systemSkills];
}

/**
 * Load skills from a specific MCP server
 * Skills from MCP are exposed as mcp__<server>__<prompt_name>
 */
export async function loadMcpSkills(
  mcpServers: Array<{ name: string; commands?: Array<{ name: string; description?: string }> }>,
): Promise<PromptSkill[]> {
  const registry = getSkillRegistry();
  const skills: PromptSkill[] = [];

  for (const server of mcpServers) {
    if (!server.commands) continue;

    for (const cmd of server.commands) {
      const skillName = `mcp__${server.name}__${cmd.name}`;

      const skill: PromptSkill = {
        type: 'prompt',
        name: skillName,
        description: cmd.description || `MCP skill from ${server.name}`,
        source: 'mcp',
        userInvocable: true,
        isHidden: false,
        async getPromptForCommand(_args, _context): Promise<string> {
          // The actual prompt content is loaded dynamically by the MCP client
          return `[Skill content loaded from MCP server ${server.name}]`;
        },
      };

      skills.push(skill);
      registry.register(skill);
    }
  }

  return skills;
}

/**
 * Get available skill directories for discovery
 * @param cwd - Current working directory
 * @param options - Optional skill load options including additional paths
 */
export async function discoverSkillDirs(
  cwd: string,
  options?: SkillLoadOptions,
): Promise<string[]> {
  const dirs: string[] = [];
  const { user, project } = getSkillDirectories(cwd);

  // Check user dir
  try {
    await fs.access(user);
    dirs.push(user);
  } catch {
    // Directory doesn't exist
  }

  // Check project dirs
  for (const projectDir of project) {
    try {
      await fs.access(projectDir);
      dirs.push(projectDir);
    } catch {
      // Directory doesn't exist
    }
  }

  // Check additional custom paths
  if (options?.additionalPaths) {
    for (const additionalPath of options.additionalPaths) {
      const resolvedPath = path.isAbsolute(additionalPath)
        ? additionalPath
        : path.join(cwd, additionalPath);
      try {
        await fs.access(resolvedPath);
        dirs.push(resolvedPath);
      } catch {
        // Directory doesn't exist
      }
    }
  }

  return dirs;
}

/**
 * Process skill content to replace relative paths with absolute paths.
 * Supports Progressive Disclosure Level 3+: converts relative file references
 * to absolute paths so Agent can easily read nested resources.
 *
 * @param content - Original skill content
 * @param skillDir - Skill directory path
 * @returns Processed content with absolute paths
 */
function processSkillPaths(content: string, skillDir: string): string {
  // Pattern 1: Directory-based paths (scripts/, references/, assets/)
  // Matches: python scripts/file.py, `scripts/file.py`, etc.
  const dirPattern = /(python\s+|`)(scripts\/|references\/|assets\/[^\s`)]+)/g;
  content = content.replace(dirPattern, (match, prefix, relPath) => {
    const absPath = path.join(skillDir, relPath);
    try {
      // Check if file exists
      if (fsSync.existsSync(absPath)) {
        return `${prefix}${absPath}`;
      }
    } catch {
      // Ignore errors
    }
    return match;
  });

  // Pattern 2: Direct markdown/document references
  // Matches phrases like "see reference.md" or "read forms.md"
  const docPattern = /(see|read|refer to|check)\s+([a-zA-Z0-9_-]+\.(?:md|txt|json|yaml))([.,;\s])/gi;
  content = content.replace(docPattern, (match, verb, filename, suffix) => {
    const absPath = path.join(skillDir, filename);
    try {
      if (fsSync.existsSync(absPath)) {
        return `${verb} \`${absPath}\` (use Read tool to access)${suffix}`;
      }
    } catch {
      // Ignore errors
    }
    return match;
  });

  // Pattern 3: Markdown links with relative paths
  // Matches: [text](file.md), [`file.md`](file.md), [text](./dir/file.md)
  const mdLinkPattern = /\[(`?[^`\]]+`?)\]\(((?:\.\/)?[^)]+\.(?:md|txt|json|yaml|js|py|html))\)/g;
  content = content.replace(mdLinkPattern, (match, linkText, filepath) => {
    // Remove leading ./ if present
    const cleanPath = filepath.startsWith('./') ? filepath.slice(2) : filepath;
    const absPath = path.join(skillDir, cleanPath);
    try {
      if (fsSync.existsSync(absPath)) {
        return `[${linkText}](\`${absPath}\`) (use Read tool to access)`;
      }
    } catch {
      // Ignore errors
    }
    return match;
  });

  return content;
}


