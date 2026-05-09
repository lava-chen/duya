/**
 * SkillDraftManager - Draft Skill 管理
 *
 * 管理位于 ~/.duya/skills-draft/ 的临时skill：
 * - 创建draft skill
 * - 晋升draft skill到正式目录
 * - 拒绝并删除draft skill
 * - 备份draft skill（用于revision对比）
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

// ============================================================================
// Constants
// ============================================================================

const DRAFT_SKILLS_DIR = path.join(homedir(), '.duya', 'skills-draft');
const SKILLS_DIR = path.join(homedir(), '.duya', 'skills');

// ============================================================================
// Types
// ============================================================================

export interface DraftSkillResult {
  success: boolean;
  path?: string;
  error?: string;
  skillName?: string;
}

export interface DraftSkillInfo {
  name: string;
  path: string;
  category?: string;
}

// ============================================================================
// Validation Helpers
// ============================================================================

function validateSkillName(name: string): string | null {
  if (!name) {
    return "Skill name is required.";
  }
  if (name.length > 64) {
    return "Skill name exceeds 64 characters.";
  }
  // Characters allowed: lowercase letters, numbers, hyphens, dots, underscores
  const VALID_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
  if (!VALID_NAME_RE.test(name)) {
    return (
      `Invalid skill name '${name}'. Use lowercase letters, numbers, ` +
      `hyphens, dots, and underscores. Must start with a letter or digit.`
    );
  }
  return null;
}

// ============================================================================
// Atomic Write
// ============================================================================

async function atomicWriteText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const dir = path.dirname(filePath);
  const name = path.basename(filePath);
  const tempPath = path.join(dir, `.${name}.tmp.${Date.now()}`);

  try {
    await fs.writeFile(tempPath, content, 'utf-8');
    await fs.rename(tempPath, filePath);
  } catch (err) {
    // Clean up temp file on error
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore
    }
    throw err;
  }
}

// ============================================================================
// Draft Skill Operations
// ============================================================================

/**
 * 在draft目录创建skill
 */
export async function createDraftSkill(
  name: string,
  content: string,
  category?: string
): Promise<DraftSkillResult> {
  // Validate name
  const validationError = validateSkillName(name);
  if (validationError) {
    return { success: false, error: validationError };
  }

  // Resolve draft directory path
  const skillDir = category
    ? path.join(DRAFT_SKILLS_DIR, category, name)
    : path.join(DRAFT_SKILLS_DIR, name);

  // Check if already exists
  try {
    await fs.access(skillDir);
    // Exists - check if it has SKILL.md
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    try {
      await fs.access(skillMdPath);
      return {
        success: false,
        error: `Draft skill '${name}' already exists at ${skillDir}`,
        path: skillDir,
      };
    } catch {
      // Directory exists but no SKILL.md - this is an error
      return {
        success: false,
        error: `Draft skill directory exists but no SKILL.md found at ${skillDir}`,
        path: skillDir,
      };
    }
  } catch {
    // Does not exist - this is what we want
  }

  // Create directory and SKILL.md
  try {
    await fs.mkdir(skillDir, { recursive: true });
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    await atomicWriteText(skillMdPath, content);

    return {
      success: true,
      path: skillDir,
      skillName: name,
    };
  } catch (err) {
    // Rollback on error
    try {
      await fs.rm(skillDir, { recursive: true, force: true });
    } catch {
      // Ignore rollback errors
    }
    return {
      success: false,
      error: `Failed to create draft skill: ${err}`,
    };
  }
}

/**
 * 将draft skill晋升为正式skill
 */
export async function promoteDraftSkill(name: string): Promise<DraftSkillResult> {
  // Validate name
  const validationError = validateSkillName(name);
  if (validationError) {
    return { success: false, error: validationError };
  }

  // Find the draft skill directory
  let draftDir: string | null = null;

  try {
    const entries = await fs.readdir(DRAFT_SKILLS_DIR);
    for (const entry of entries) {
      const entryPath = path.join(DRAFT_SKILLS_DIR, entry);
      const stat = await fs.stat(entryPath);

      if (stat.isDirectory()) {
        // Check if entry is the skill name directly
        if (entry === name) {
          draftDir = entryPath;
          break;
        }

        // Check if it's a category directory
        const skillPath = path.join(entryPath, name);
        try {
          const skillStat = await fs.stat(skillPath);
          if (skillStat.isDirectory()) {
            draftDir = skillPath;
            break;
          }
        } catch {
          // Not this directory
        }
      }
    }
  } catch {
    return { success: false, error: `Draft skill '${name}' not found` };
  }

  if (!draftDir) {
    return { success: false, error: `Draft skill '${name}' not found` };
  }

  // Check SKILL.md exists
  const draftSkillMd = path.join(draftDir, 'SKILL.md');
  try {
    await fs.access(draftSkillMd);
  } catch {
    return { success: false, error: `SKILL.md not found in draft skill '${name}'` };
  }

  // Infer category from directory structure
  // draftDir could be: ~/.duya/skills-draft/{category}/{name}/ or ~/.duya/skills-draft/{name}/
  let category: string | undefined;
  const relativeToDraft = path.relative(DRAFT_SKILLS_DIR, draftDir);
  const pathParts = relativeToDraft.split(path.sep);
  if (pathParts.length >= 2) {
    // If path has 2+ parts, the first part is the category
    category = pathParts[0];
  }

  // Determine target directory
  const targetDir = category
    ? path.join(SKILLS_DIR, category, name)
    : path.join(SKILLS_DIR, name);

  // Check if target already exists
  try {
    await fs.access(targetDir);
    return {
      success: false,
      error: `正式 skill '${name}' already exists at ${targetDir}`,
      path: targetDir,
    };
  } catch {
    // Does not exist - good
  }

  // Move draft to target
  try {
    await fs.mkdir(path.dirname(targetDir), { recursive: true });
    await fs.rename(draftDir, targetDir);

    return {
      success: true,
      path: targetDir,
      skillName: name,
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to promote draft skill: ${err}`,
    };
  }
}

/**
 * 拒绝并删除draft skill
 */
export async function rejectDraftSkill(name: string): Promise<DraftSkillResult> {
  // Validate name
  const validationError = validateSkillName(name);
  if (validationError) {
    return { success: false, error: validationError };
  }

  // Find and delete the draft skill directory
  try {
    const entries = await fs.readdir(DRAFT_SKILLS_DIR);
    for (const entry of entries) {
      const entryPath = path.join(DRAFT_SKILLS_DIR, entry);
      const stat = await fs.stat(entryPath);

      if (stat.isDirectory()) {
        // Check if entry is the skill name directly
        if (entry === name) {
          await fs.rm(entryPath, { recursive: true, force: true });
          return { success: true, skillName: name };
        }

        // Check if it's a category directory
        const skillPath = path.join(entryPath, name);
        try {
          const skillStat = await fs.stat(skillPath);
          if (skillStat.isDirectory()) {
            await fs.rm(skillPath, { recursive: true, force: true });
            return { success: true, skillName: name };
          }
        } catch {
          // Not this directory
        }
      }
    }
  } catch {
    // Draft directory doesn't exist - that's fine, skill is already gone
    return { success: true, skillName: name };
  }

  return { success: false, error: `Draft skill '${name}' not found` };
}

/**
 * 读取draft skill内容
 */
export async function readDraftSkill(name: string): Promise<string | null> {
  // Validate name
  const validationError = validateSkillName(name);
  if (validationError) {
    return null;
  }

  try {
    const entries = await fs.readdir(DRAFT_SKILLS_DIR);
    for (const entry of entries) {
      const entryPath = path.join(DRAFT_SKILLS_DIR, entry);
      const stat = await fs.stat(entryPath);

      if (stat.isDirectory()) {
        // Check if entry is the skill name directly
        if (entry === name) {
          const skillMdPath = path.join(entryPath, 'SKILL.md');
          return await fs.readFile(skillMdPath, 'utf-8');
        }

        // Check if it's a category directory
        const skillPath = path.join(entryPath, name);
        try {
          const skillStat = await fs.stat(skillPath);
          if (skillStat.isDirectory()) {
            const skillMdPath = path.join(skillPath, 'SKILL.md');
            return await fs.readFile(skillMdPath, 'utf-8');
          }
        } catch {
          // Not this directory
        }
      }
    }
  } catch {
    // Draft directory doesn't exist
    return null;
  }

  return null;
}

/**
 * 列出所有draft skills
 */
export async function listDraftSkills(): Promise<DraftSkillInfo[]> {
  const skills: DraftSkillInfo[] = [];

  try {
    const entries = await fs.readdir(DRAFT_SKILLS_DIR);
    for (const entry of entries) {
      const entryPath = path.join(DRAFT_SKILLS_DIR, entry);
      const stat = await fs.stat(entryPath);

      if (stat.isDirectory()) {
        // Check if entry is a skill directly
        const skillMdPath = path.join(entryPath, 'SKILL.md');
        try {
          await fs.access(skillMdPath);
          skills.push({ name: entry, path: entryPath });
          continue;
        } catch {
          // Not a direct skill, might be a category
        }

        // It's a category directory - look for skills inside
        const categoryEntries = await fs.readdir(entryPath);
        for (const skillEntry of categoryEntries) {
          const skillPath = path.join(entryPath, skillEntry);
          const skillStat = await fs.stat(skillPath);
          if (skillStat.isDirectory()) {
            const skillMdPath = path.join(skillPath, 'SKILL.md');
            try {
              await fs.access(skillMdPath);
              skills.push({ name: skillEntry, path: skillPath, category: entry });
            } catch {
              // No SKILL.md - skip
            }
          }
        }
      }
    }
  } catch {
    // Draft directory doesn't exist - return empty list
    return [];
  }

  return skills;
}

/**
 * 备份draft skill（用于revision对比）
 */
export async function backupDraftSkill(name: string): Promise<DraftSkillResult> {
  const content = await readDraftSkill(name);
  if (!content) {
    return { success: false, error: `Draft skill '${name}' not found` };
  }

  // Find the draft skill directory
  let draftDir: string | null = null;

  try {
    const entries = await fs.readdir(DRAFT_SKILLS_DIR);
    for (const entry of entries) {
      const entryPath = path.join(DRAFT_SKILLS_DIR, entry);
      const stat = await fs.stat(entryPath);

      if (stat.isDirectory()) {
        if (entry === name) {
          draftDir = entryPath;
          break;
        }

        const skillPath = path.join(entryPath, name);
        try {
          const skillStat = await fs.stat(skillPath);
          if (skillStat.isDirectory()) {
            draftDir = skillPath;
            break;
          }
        } catch {
          // Not this directory
        }
      }
    }
  } catch {
    return { success: false, error: `Failed to find draft skill '${name}'` };
  }

  if (!draftDir) {
    return { success: false, error: `Draft skill '${name}' not found` };
  }

  // Create backup
  const backupPath = path.join(draftDir, 'SKILL.md.backup');
  try {
    await atomicWriteText(backupPath, content);
    return { success: true, path: backupPath, skillName: name };
  } catch (err) {
    return { success: false, error: `Failed to create backup: ${err}` };
  }
}

/**
 * 获取draft skill目录路径
 */
export function getDraftSkillsDir(): string {
  return DRAFT_SKILLS_DIR;
}

// ============================================================================
// SkillDraftManager Class (alternative API)
// ============================================================================

export class SkillDraftManager {
  async create(name: string, content: string, category?: string): Promise<DraftSkillResult> {
    return createDraftSkill(name, content, category);
  }

  async promote(name: string): Promise<DraftSkillResult> {
    return promoteDraftSkill(name);
  }

  async reject(name: string): Promise<DraftSkillResult> {
    return rejectDraftSkill(name);
  }

  async read(name: string): Promise<string | null> {
    return readDraftSkill(name);
  }

  async list(): Promise<DraftSkillInfo[]> {
    return listDraftSkills();
  }

  async backup(name: string): Promise<DraftSkillResult> {
    return backupDraftSkill(name);
  }
}

// ============================================================================
// Singleton instance
// ============================================================================

let defaultDraftManager: SkillDraftManager | null = null;

export function getDefaultDraftManager(): SkillDraftManager {
  if (!defaultDraftManager) {
    defaultDraftManager = new SkillDraftManager();
  }
  return defaultDraftManager;
}
