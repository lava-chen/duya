/**
 * Skill Loader for duya Agent
 * Loads skills from filesystem directories
 * Adapted from claude-code-haha/src/skills/loadSkillsDir.ts
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir, platform as getPlatform } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ToolUseContext } from '../types.js';
import type { PromptSkill, SkillArgument, SkillCategory, SkillSource } from './types.js';
import { getSkillRegistry } from './registry.js';
import { scanSkillFile, shouldAllowInstall, type SkillFinding } from '../security/skillScanner.js';

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
  'development': 'development',
  'research': 'research',
  'creative': 'creative',
  'productivity': 'productivity',
  'data-science': 'data-science',
  'automation': 'automation',
  'communication': 'communication',
  'media': 'media',
  'mcp': 'mcp',
  'system': 'system',
  'other': 'other',
};

// Frontmatter regex
const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)---\s*\n?/;

/**
 * Parse frontmatter from markdown content
 */
function parseFrontmatter(
  markdown: string,
): { frontmatter: Record<string, unknown>; content: string } {
  const match = markdown.match(FRONTMATTER_REGEX);

  if (!match) {
    return { frontmatter: {}, content: markdown };
  }

  const frontmatterText = match[1] || '';
  const content = markdown.slice(match[0].length);

  // Simple YAML parsing for basic fields
  const frontmatter: Record<string, unknown> = {};
  const lines = frontmatterText.split('\n');

  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    let value: string = line.slice(colonIndex + 1).trim();

    // Handle quoted strings
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Handle boolean
    if (value === 'true') {
      frontmatter[key] = true;
      continue;
    }
    if (value === 'false') {
      frontmatter[key] = false;
      continue;
    }

    // Handle arrays (comma-separated)
    if (
      value.includes(',') &&
      !value.startsWith('[')
    ) {
      if (
        key === 'allowed-tools' ||
        key === 'arguments' ||
        key === 'paths'
      ) {
        frontmatter[key] = value
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);
        continue;
      }
    }

    frontmatter[key] = value;
  }

  return { frontmatter, content };
}

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
): Promise<PromptSkill | null> {
  const skillFilePath = path.join(skillDir, 'SKILL.md');

  let content: string;
  try {
    content = await fs.readFile(skillFilePath, 'utf-8');
  } catch {
    return null;
  }

  // Parse frontmatter and content
  const { frontmatter, content: markdownContent } = parseFrontmatter(content);

  // ── Security scan ─────────────────────────────────────────────────────
  // Scan SKILL.md for injection/exfiltration/destructive patterns
  // Skip security scan for bundled (built-in) skills - they are trusted
  // Also skip if user has explicitly chosen to bypass security for this skill
  const isBypassed = securityBypassSkills?.includes(skillName) ?? false;
  let findings: ReturnType<typeof scanSkillFile> = [];
  if (source !== 'bundled' && !isBypassed) {
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
    const { frontmatter } = parseFrontmatter(content);
    const description = frontmatter.description as string | undefined;
    return description?.trim();
  } catch {
    return undefined;
  }
}

/**
 * Load skills from a specific directory
 * If the directory has a DESCRIPTION.md, it's a category directory
 * and skills are loaded from subdirectories with category inherited from parent
 */
async function loadSkillsFromDirectory(
  dirPath: string,
  source: SkillSource,
  parentCategory?: SkillCategory,
  securityBypassSkills?: string[],
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

    const entryPath = path.join(dirPath, entry);

    let stat;
    try {
      stat = await fs.stat(entryPath);
    } catch {
      continue;
    }

    if (!stat.isDirectory()) continue;

    const inheritedCategory = isCategoryDir ? CATEGORY_MAP[entry.toLowerCase()] ?? parentCategory : parentCategory;
    const skill = await createSkillFromDirectory(entryPath, entry, source, inheritedCategory, securityBypassSkills);
    if (skill) {
      skills.push(skill);
    } else {
      // If not a skill directory, recursively try to load as category directory
      // This handles nested category structures like skills/apple/apple-notes/
      const nestedSkills = await loadSkillsFromDirectory(entryPath, source, inheritedCategory, securityBypassSkills);
      skills.push(...nestedSkills);
    }
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
}

/**
 * Get the default skill directories
 * Default: ~/.duya/skills (user) and <cwd>/.duya/skills (project)
 */
export function getSkillDirectories(cwd: string): {
  user: string;
  project: string;
} {
  return {
    user: path.join(homedir(), '.duya', 'skills'),
    project: path.join(cwd, '.duya', 'skills'),
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

  // Load all skills from user directory (~/.duya/skills/)
  // This includes synced built-in skills AND user-added skills
  const userSkills = await loadSkillsFromDirectory(user, 'user', undefined, securityBypassSkills);

  // Re-mark bundled skills with correct source so they skip security checks
  try {
    const { listBundledSkillNames } = await import('./skillsSync.js');
    const bundledNames = await listBundledSkillNames();
    const bundledNameSet = new Set(bundledNames);
    for (const skill of userSkills) {
      if (bundledNameSet.has(skill.name)) {
        skill.source = 'bundled';
      }
    }
    if (bundledNameSet.size > 0) {
      console.log(`[Skills] ${bundledNameSet.size} bundled skills marked as trusted`);
    }
  } catch (e) {
    console.warn('[Skills] Failed to re-mark bundled skills:', e);
  }
  allSkills.push(...userSkills);

  // Load project-level skills
  const projectSkills = await loadSkillsFromDirectory(project, 'project', undefined, securityBypassSkills);
  allSkills.push(...projectSkills);

  // Load skills from additional custom paths
  if (options?.additionalPaths) {
    for (const additionalPath of options.additionalPaths) {
      // Resolve relative paths against cwd
      const resolvedPath = path.isAbsolute(additionalPath)
        ? additionalPath
        : path.join(cwd, additionalPath);
      const additionalSkills = await loadSkillsFromDirectory(resolvedPath, 'user', undefined, securityBypassSkills);
      allSkills.push(...additionalSkills);
    }
  }

  // Register all skills
  for (const skill of allSkills) {
    getSkillRegistry().register(skill);
  }

  return allSkills;
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

  // Check project dir
  try {
    await fs.access(project);
    dirs.push(project);
  } catch {
    // Directory doesn't exist
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

// Import sync fs for path checking
import fsSync from 'node:fs';
