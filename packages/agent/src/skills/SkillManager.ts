/**
 * SkillManager - Agent-Managed Skill Creation & Editing
 *
 * Allows the agent to create, update, and delete skills, turning successful
 * approaches into reusable procedural knowledge. Skills are created in
 * ~/.duya/skills/. Existing skills can be modified or deleted.
 *
 * Actions:
 *   create     -- Create a new skill (SKILL.md + directory structure)
 *   edit       -- Replace the SKILL.md content of a user skill (full rewrite)
 *   patch      -- Targeted find-and-replace within SKILL.md or any supporting file
 *   delete     -- Remove a user skill entirely
 *   write_file -- Add/overwrite a supporting file (reference, template, script, asset)
 *   remove_file-- Remove a supporting file from a user skill
 *
 * Directory layout for user skills:
 *     ~/.duya/skills/
 *     ├── my-skill/
 *     │   ├── SKILL.md
 *     │   ├── references/
 *     │   ├── templates/
 *     │   ├── scripts/
 *     │   └── assets/
 *     └── category-name/
 *         └── another-skill/
 *             └── SKILL.md
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'yaml';
import { homedir } from 'node:os';
import { createDraftSkill, promoteDraftSkill, rejectDraftSkill } from './SkillDraftManager.js';

// ============================================================================
// Constants
// ============================================================================

const SKILLS_DIR = path.join(homedir(), '.duya', 'skills');

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_SKILL_CONTENT_CHARS = 100_000;
const MAX_SKILL_FILE_BYTES = 1_048_576;

// Characters allowed in skill names (filesystem-safe, URL-friendly)
const VALID_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

// Subdirectories allowed for write_file/remove_file
const ALLOWED_SUBDIRS = ['references', 'templates', 'scripts', 'assets'];

// ============================================================================
// Types
// ============================================================================

export interface SkillResult {
  success: boolean;
  message: string;
  error?: string;
  path?: string;
  skill_md?: string;
  category?: string;
  hint?: string;
  available_files?: string[];
}

export interface SkillDir {
  path: string;
}

// ============================================================================
// Validation Helpers
// ============================================================================

function validateName(name: string): string | null {
  if (!name) {
    return "Skill name is required.";
  }
  if (name.length > MAX_NAME_LENGTH) {
    return `Skill name exceeds ${MAX_NAME_LENGTH} characters.`;
  }
  if (!VALID_NAME_RE.test(name)) {
    return (
      `Invalid skill name '${name}'. Use lowercase letters, numbers, ` +
      `hyphens, dots, and underscores. Must start with a letter or digit.`
    );
  }
  return null;
}

function validateCategory(category: string | null | undefined): string | null {
  if (!category) return null;
  if (typeof category !== 'string') {
    return "Category must be a string.";
  }

  category = category.trim();
  if (!category) return null;
  if (category.includes('/') || category.includes('\\')) {
    return (
      `Invalid category '${category}'. Use lowercase letters, numbers, ` +
      "hyphens, dots, and underscores. Categories must be a single directory name."
    );
  }
  if (category.length > MAX_NAME_LENGTH) {
    return `Category exceeds ${MAX_NAME_LENGTH} characters.`;
  }
  if (!VALID_NAME_RE.test(category)) {
    return (
      `Invalid category '${category}'. Use lowercase letters, numbers, ` +
      "hyphens, dots, and underscores. Categories must be a single directory name."
    );
  }
  return null;
}

function validateFrontmatter(content: string): string | null {
  if (!content.trim()) {
    return "Content cannot be empty.";
  }

  if (!content.startsWith('---')) {
    return "SKILL.md must start with YAML frontmatter (---). See existing skills for format.";
  }

  const endMatch = content.match(/\n---\s*\n/);
  if (!endMatch) {
    return "SKILL.md frontmatter is not closed. Ensure you have a closing '---' line.";
  }

  const yamlContent = content.slice(3, endMatch.index! + 3);

  let parsed: Record<string, unknown>;
  try {
    parsed = yaml.parse(yamlContent) as Record<string, unknown>;
  } catch (e) {
    return `YAML frontmatter parse error: ${e}`;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return "Frontmatter must be a YAML mapping (key: value pairs).";
  }

  if (!parsed.name) {
    return "Frontmatter must include 'name' field.";
  }
  if (!parsed.description) {
    return "Frontmatter must include 'description' field.";
  }
  if (typeof parsed.description === 'string' && parsed.description.length > MAX_DESCRIPTION_LENGTH) {
    return `Description exceeds ${MAX_DESCRIPTION_LENGTH} characters.`;
  }

  const body = content.slice(endMatch.index! + endMatch[0].length).trim();
  if (!body) {
    return "SKILL.md must have content after the frontmatter (instructions, procedures, etc.).";
  }

  return null;
}

function validateContentSize(content: string, label = "SKILL.md"): string | null {
  if (content.length > MAX_SKILL_CONTENT_CHARS) {
    return (
      `${label} content is ${content.length.toLocaleString()} characters ` +
      `(limit: ${MAX_SKILL_CONTENT_CHARS.toLocaleString()}). ` +
      `Consider splitting into a smaller SKILL.md with supporting files ` +
      `in references/ or templates/.`
    );
  }
  return null;
}

function validateFilePath(filePath: string): string | null {
  if (!filePath) {
    return "file_path is required.";
  }

  // Must be under an allowed subdirectory
  const firstPart = filePath.split('/')[0] || filePath.split('\\')[0];
  if (!ALLOWED_SUBDIRS.includes(firstPart)) {
    const allowed = ALLOWED_SUBDIRS.join(', ');
    return `File must be under one of: ${allowed}. Got: '${firstPart}'`;
  }

  // Must have a filename (not just a directory)
  const parts = filePath.split('/');
  if (parts.length < 2 && !filePath.includes('\\')) {
    return `Provide a file path, not just a directory. Example: '${firstPart}/myfile.md'`;
  }

  return null;
}

// ============================================================================
// Path Resolution
// ============================================================================

function resolveSkillDir(name: string, category?: string): string {
  if (category) {
    return path.join(SKILLS_DIR, category, name);
  }
  return path.join(SKILLS_DIR, name);
}

async function findSkill(name: string): Promise<SkillDir | null> {
  let skillsDir: string[];
  try {
    skillsDir = await fs.readdir(SKILLS_DIR);
  } catch {
    return null;
  }

  for (const entry of skillsDir) {
    const entryPath = path.join(SKILLS_DIR, entry);
    let stat;
    try {
      stat = await fs.stat(entryPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      // Check if this directory contains the skill
      const skillPath = path.join(entryPath, name);
      try {
        const skillStat = await fs.stat(skillPath);
        if (skillStat.isDirectory()) {
          return { path: skillPath };
        }
      } catch {
        // Not this directory
      }

      // Direct match: entry is the skill name
      if (entry === name) {
        return { path: entryPath };
      }
    }
  }

  return null;
}

function resolveSkillTarget(skillDir: string, filePath: string): [string, null] | [null, string] {
  const target = path.join(skillDir, filePath);

  // Ensure target is within skillDir (no traversal)
  const resolvedTarget = path.resolve(target);
  const resolvedSkillDir = path.resolve(skillDir);

  if (!resolvedTarget.startsWith(resolvedSkillDir + path.sep) && resolvedTarget !== resolvedSkillDir) {
    return [null, "Path traversal is not allowed."];
  }

  return [target, null];
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
// Core Actions
// ============================================================================

async function createSkill(name: string, content: string, category?: string): Promise<SkillResult> {
  // Validate name
  let err = validateName(name);
  if (err) return { success: false, message: '', error: err };

  // Validate category
  err = validateCategory(category);
  if (err) return { success: false, message: '', error: err };

  // Validate content
  err = validateFrontmatter(content);
  if (err) return { success: false, message: '', error: err };

  err = validateContentSize(content);
  if (err) return { success: false, message: '', error: err };

  // Check for name collisions
  const existing = await findSkill(name);
  if (existing) {
    return {
      success: false,
      message: '',
      error: `A skill named '${name}' already exists at ${existing.path}.`,
    };
  }

  // Create the skill directory
  const skillDir = resolveSkillDir(name, category);
  await fs.mkdir(skillDir, { recursive: true });

  // Write SKILL.md atomically
  const skillMd = path.join(skillDir, 'SKILL.md');
  try {
    await atomicWriteText(skillMd, content);
  } catch (e) {
    // Roll back on error
    try {
      await fs.rm(skillDir, { recursive: true, force: true });
    } catch {
      // Ignore rollback errors
    }
    return {
      success: false,
      message: '',
      error: `Failed to write SKILL.md: ${e}`,
    };
  }

  const result: SkillResult = {
    success: true,
    message: `Skill '${name}' created.`,
    path: path.relative(SKILLS_DIR, skillDir),
    skill_md: skillMd,
  };
  if (category) {
    result.category = category;
  }
  result.hint = `To add reference files, templates, or scripts, use skill_manage(action='write_file', name='${name}', file_path='references/example.md', file_content='...')`;

  return result;
}

async function editSkill(name: string, content?: string, oldString?: string, newString?: string): Promise<SkillResult> {
  const existing = await findSkill(name);
  if (!existing) {
    return {
      success: false,
      message: '',
      error: `Skill '${name}' not found. Use skills_list() to see available skills.`,
    };
  }

  const skillMd = path.join(existing.path, 'SKILL.md');

  // Read current content
  let currentContent: string;
  try {
    currentContent = await fs.readFile(skillMd, 'utf-8');
  } catch (e) {
    return {
      success: false,
      message: '',
      error: `Failed to read SKILL.md: ${e}`,
    };
  }

  let newContent: string;

  // If old_string/new_string provided, do patch-style edit
  if (oldString !== undefined || newString !== undefined) {
    if (!oldString) {
      return { success: false, message: '', error: "old_string is required when using patch-style edit." };
    }
    if (newString === undefined || newString === null) {
      return { success: false, message: '', error: "new_string is required when using patch-style edit." };
    }

    const index = currentContent.indexOf(oldString);
    if (index === -1) {
      return {
        success: false,
        message: '',
        error: `old_string not found in SKILL.md.`,
      };
    }
    newContent = currentContent.slice(0, index) + newString + currentContent.slice(index + oldString.length);
  } else if (content) {
    // Full content rewrite
    let err = validateFrontmatter(content);
    if (err) return { success: false, message: '', error: err };

    err = validateContentSize(content);
    if (err) return { success: false, message: '', error: err };

    newContent = content;
  } else {
    return {
      success: false,
      message: '',
      error: "Either 'content' (full rewrite) or both 'old_string' and 'new_string' (patch-style) must be provided for 'edit'.",
    };
  }

  // Validate the result won't break SKILL.md
  const frontmatterError = validateFrontmatter(newContent);
  if (frontmatterError) {
    return {
      success: false,
      message: '',
      error: `Edit would break SKILL.md structure: ${frontmatterError}`,
    };
  }

  // Back up original content for rollback
  const originalContent = currentContent;

  try {
    await atomicWriteText(skillMd, newContent);
  } catch (e) {
    await atomicWriteText(skillMd, originalContent);
    return {
      success: false,
      message: '',
      error: `Failed to write SKILL.md: ${e}`,
    };
  }

  return {
    success: true,
    message: `Skill '${name}' updated.`,
    path: existing.path,
  };
}

async function patchSkill(
  name: string,
  oldString: string,
  newString: string,
  filePath?: string,
  replaceAll = false,
): Promise<SkillResult> {
  if (!oldString) {
    return { success: false, message: '', error: "old_string is required for 'patch'." };
  }
  if (newString === undefined || newString === null) {
    return { success: false, message: '', error: "new_string is required for 'patch'. Use empty string to delete matched text." };
  }

  const existing = await findSkill(name);
  if (!existing) {
    return { success: false, message: '', error: `Skill '${name}' not found.` };
  }

  const skillDir = existing.path;

  let target: string;
  if (filePath) {
    const validationError = validateFilePath(filePath);
    if (validationError) {
      return { success: false, message: '', error: validationError };
    }
    const [resolved, resolveError] = resolveSkillTarget(skillDir, filePath);
    if (resolveError) {
      return { success: false, message: '', error: resolveError };
    }
    target = resolved!;
  } else {
    target = path.join(skillDir, 'SKILL.md');
  }

  let content: string;
  try {
    content = await fs.readFile(target, 'utf-8');
  } catch {
    return { success: false, message: '', error: `File not found: ${filePath || 'SKILL.md'}` };
  }

  // Perform the replacement
  let matchCount = 0;
  let newContent: string;

  if (replaceAll) {
    const escaped = oldString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'g');
    const matches = content.match(regex);
    matchCount = matches ? matches.length : 0;
    newContent = content.replace(regex, newString);
  } else {
    const index = content.indexOf(oldString);
    if (index === -1) {
      const preview = content.slice(0, 500) + (content.length > 500 ? '...' : '');
      return {
        success: false,
        message: '',
        error: `old_string not found in ${filePath || 'SKILL.md'}.`,
      };
    }
    newContent = content.slice(0, index) + newString + content.slice(index + oldString.length);
    matchCount = 1;
  }

  // Check size limit on the result
  const label = filePath || 'SKILL.md';
  const sizeError = validateContentSize(newContent, label);
  if (sizeError) {
    return { success: false, message: '', error: sizeError };
  }

  // If patching SKILL.md, validate frontmatter is still intact
  if (!filePath) {
    const frontmatterError = validateFrontmatter(newContent);
    if (frontmatterError) {
      // Provide more helpful error message
      let hint = '';
      if (frontmatterError.includes('must start with YAML frontmatter')) {
        hint = ' Hint: Your old_string may have included the frontmatter boundary (---). When patching SKILL.md body, only include content after the frontmatter.';
      } else if (frontmatterError.includes('not closed')) {
        hint = ' Hint: Your patch may have broken the frontmatter structure. Ensure the closing --- remains intact.';
      } else if (frontmatterError.includes('name') || frontmatterError.includes('description')) {
        hint = ' Hint: Your patch may have removed required frontmatter fields (name, description). These are required.';
      }
      return {
        success: false,
        message: '',
        error: `Patch would break SKILL.md structure: ${frontmatterError}${hint}`,
      };
    }
  }

  // Write atomically
  try {
    await atomicWriteText(target, newContent);
  } catch (e) {
    return { success: false, message: '', error: `Failed to write: ${e}` };
  }

  return {
    success: true,
    message: `Patched ${label || 'SKILL.md'} in skill '${name}' (${matchCount} replacement${matchCount > 1 ? 's' : ''}).`,
  };
}

async function deleteSkill(name: string): Promise<SkillResult> {
  const existing = await findSkill(name);
  if (!existing) {
    return { success: false, message: '', error: `Skill '${name}' not found.` };
  }

  const skillDir = existing.path;

  try {
    await fs.rm(skillDir, { recursive: true, force: true });
  } catch (e) {
    return { success: false, message: '', error: `Failed to delete skill: ${e}` };
  }

  // Clean up empty category directories
  const parent = path.dirname(skillDir);
  if (parent !== SKILLS_DIR) {
    try {
      const entries = await fs.readdir(parent);
      if (entries.length === 0) {
        await fs.rmdir(parent);
      }
    } catch {
      // Ignore
    }
  }

  return {
    success: true,
    message: `Skill '${name}' deleted.`,
  };
}

async function writeFile(name: string, filePath: string, fileContent: string): Promise<SkillResult> {
  const validationError = validateFilePath(filePath);
  if (validationError) {
    return { success: false, message: '', error: validationError };
  }

  if (fileContent === undefined || fileContent === null) {
    return { success: false, message: '', error: "file_content is required for 'write_file'." };
  }

  // Check size limits
  const contentBytes = Buffer.byteLength(fileContent, 'utf-8');
  if (contentBytes > MAX_SKILL_FILE_BYTES) {
    return {
      success: false,
      message: '',
      error: (
        `File content is ${contentBytes.toLocaleString()} bytes ` +
        `(limit: ${MAX_SKILL_FILE_BYTES.toLocaleString()} bytes / 1 MiB). ` +
        `Consider splitting into smaller files.`
      ),
    };
  }

  const sizeError = validateContentSize(fileContent, filePath);
  if (sizeError) {
    return { success: false, message: '', error: sizeError };
  }

  const existing = await findSkill(name);
  if (!existing) {
    return {
      success: false,
      message: '',
      error: `Skill '${name}' not found. Create it first with action='create'.`,
    };
  }

  const [target, resolveError] = resolveSkillTarget(existing.path, filePath);
  if (resolveError) {
    return { success: false, message: '', error: resolveError };
  }

  const targetPath = target!;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  // Back up for rollback
  let originalContent: string | null = null;
  try {
    originalContent = await fs.readFile(targetPath, 'utf-8');
  } catch {
    // File doesn't exist yet
  }

  try {
    await atomicWriteText(targetPath, fileContent);
  } catch (e) {
    if (originalContent !== null) {
      await atomicWriteText(targetPath, originalContent);
    }
    return { success: false, message: '', error: `Failed to write file: ${e}` };
  }

  return {
    success: true,
    message: `File '${filePath}' written to skill '${name}'.`,
    path: targetPath,
  };
}

async function removeFile(name: string, filePath: string): Promise<SkillResult> {
  const validationError = validateFilePath(filePath);
  if (validationError) {
    return { success: false, message: '', error: validationError };
  }

  const existing = await findSkill(name);
  if (!existing) {
    return { success: false, message: '', error: `Skill '${name}' not found.` };
  }

  const skillDir = existing.path;
  const [target, resolveError] = resolveSkillTarget(skillDir, filePath);
  if (resolveError) {
    return { success: false, message: '', error: resolveError };
  }

  const targetPath = target!;
  let exists = false;
  try {
    await fs.access(targetPath);
    exists = true;
  } catch {
    exists = false;
  }

  if (!exists) {
    // List what's actually there
    const available: string[] = [];
    for (const subdir of ALLOWED_SUBDIRS) {
      const subdirPath = path.join(skillDir, subdir);
      try {
        const entries = await fs.readdir(subdirPath);
        for (const entry of entries) {
          available.push(`${subdir}/${entry}`);
        }
      } catch {
        // Directory doesn't exist
      }
    }
    return {
      success: false,
      message: '',
      error: `File '${filePath}' not found in skill '${name}'.`,
      available_files: available.length > 0 ? available : undefined,
    };
  }

  try {
    await fs.unlink(targetPath);
  } catch (e) {
    return { success: false, message: '', error: `Failed to remove file: ${e}` };
  }

  // Clean up empty subdirectories
  const parent = path.dirname(targetPath);
  if (parent !== skillDir) {
    try {
      const entries = await fs.readdir(parent);
      if (entries.length === 0) {
        await fs.rmdir(parent);
      }
    } catch {
      // Ignore
    }
  }

  return {
    success: true,
    message: `File '${filePath}' removed from skill '${name}'.`,
  };
}

// ============================================================================
// Main Entry Point
// ============================================================================

export interface SkillManageParams {
  action: 'create' | 'patch' | 'edit' | 'delete' | 'write_file' | 'remove_file' | 'draft' | 'promote' | 'reject';
  name: string;
  content?: string;
  category?: string;
  file_path?: string;
  file_content?: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
}

export async function skillManage(params: SkillManageParams): Promise<SkillResult> {
  const { action, name, content, category, file_path, file_content, old_string, new_string, replace_all } = params;

  let result: SkillResult;

  switch (action) {
    case 'create':
      if (!content) {
        return { success: false, message: '', error: "content is required for 'create'. Provide the full SKILL.md text (frontmatter + body)." };
      }
      result = await createSkill(name, content, category);
      break;

    case 'edit':
      // edit supports both full content rewrite and patch-style (old_string/new_string)
      result = await editSkill(name, content, old_string, new_string);
      break;

    case 'patch':
      if (!old_string) {
        return { success: false, message: '', error: "old_string is required for 'patch'. Provide the text to find." };
      }
      if (new_string === undefined || new_string === null) {
        return { success: false, message: '', error: "new_string is required for 'patch'. Use empty string to delete matched text." };
      }
      result = await patchSkill(name, old_string, new_string, file_path, replace_all);
      break;

    case 'delete':
      result = await deleteSkill(name);
      break;

    case 'write_file':
      if (!file_path) {
        return { success: false, message: '', error: "file_path is required for 'write_file'. Example: 'references/api-guide.md'" };
      }
      if (file_content === undefined || file_content === null) {
        return { success: false, message: '', error: "file_content is required for 'write_file'." };
      }
      result = await writeFile(name, file_path, file_content);
      break;

    case 'remove_file':
      if (!file_path) {
        return { success: false, message: '', error: "file_path is required for 'remove_file'." };
      }
      result = await removeFile(name, file_path);
      break;

    case 'draft':
      if (!content) {
        return { success: false, message: '', error: "content is required for 'draft'. Provide the full SKILL.md text (frontmatter + body)." };
      }
      {
        const draftResult = await createDraftSkill(name, content, category);
        result = {
          success: draftResult.success,
          message: draftResult.success ? `Draft skill '${name}' created at ${draftResult.path}` : '',
          error: draftResult.error,
          path: draftResult.path,
        };
      }
      break;

    case 'promote':
      {
        const promoteResult = await promoteDraftSkill(name);
        result = {
          success: promoteResult.success,
          message: promoteResult.success ? `Draft skill '${name}' promoted to ${promoteResult.path}` : '',
          error: promoteResult.error,
          path: promoteResult.path,
        };
      }
      break;

    case 'reject':
      {
        const rejectResult = await rejectDraftSkill(name);
        result = {
          success: rejectResult.success,
          message: rejectResult.success ? `Draft skill '${name}' rejected and deleted` : '',
          error: rejectResult.error,
        };
      }
      break;

    default:
      result = { success: false, message: '', error: `Unknown action '${action}'. Use: create, edit, patch, delete, write_file, remove_file, draft, promote, reject` };
  }

  // Note: In hermes-agent, this calls clear_skills_system_prompt_cache().
  // DUYA's prompt cache is rebuilt per-session, so no explicit cache clear is needed.

  return result;
}

// ============================================================================
// SkillManager Class (alternative API)
// ============================================================================

export class SkillManager {
  async create(name: string, content: string, category?: string): Promise<SkillResult> {
    return createSkill(name, content, category);
  }

  async edit(name: string, content?: string, oldString?: string, newString?: string): Promise<SkillResult> {
    return editSkill(name, content, oldString, newString);
  }

  async patch(name: string, oldString: string, newString: string, filePath?: string): Promise<SkillResult> {
    return patchSkill(name, oldString, newString, filePath, false);
  }

  async delete(name: string): Promise<SkillResult> {
    return deleteSkill(name);
  }

  async writeFile(name: string, filePath: string, fileContent: string): Promise<SkillResult> {
    return writeFile(name, filePath, fileContent);
  }

  async removeFile(name: string, filePath: string): Promise<SkillResult> {
    return removeFile(name, filePath);
  }
}
