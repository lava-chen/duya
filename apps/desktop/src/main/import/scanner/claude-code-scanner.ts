import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import type { ImportItem, ScanResult, ImportSource } from '../types';
import { assessRisk } from './secret-redactor';

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function readDir(dirPath: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(dirPath);
  } catch {
    return [];
  }
}

async function glob(pattern: string, cwd: string): Promise<string[]> {
  const entries = await readDir(cwd);
  if (pattern === '*.md') {
    return entries.filter((e) => e.endsWith('.md'));
  }
  return entries;
}

async function readFileContent(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function summarize(content: string, maxLen: number = 200): string {
  const trimmed = content.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen) + '...';
}

function contentPreview(content: string, maxLen: number = 500): string {
  const trimmed = content.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen) + '...';
}

async function buildImportItem(
  filePath: string,
  type: ImportItem['type'],
  source: ImportSource,
  scope: 'user' | 'project' | 'local-private',
  title: string,
): Promise<ImportItem> {
  const content = await readFileContent(filePath);
  const riskLevel = assessRisk(type, content);

  return {
    id: randomUUID(),
    source,
    sourcePath: filePath,
    type,
    title,
    summary: summarize(content),
    contentPreview: contentPreview(content),
    scope,
    riskLevel,
    requiresAuthorization: riskLevel === 'restricted',
    conflictKeys: [],
    defaultSelected: riskLevel !== 'restricted',
  };
}

function findClaudeCodeUserDir(): string {
  return path.join(os.homedir(), '.claude');
}

function isClaudeCodeInstalled(): boolean {
  const userDir = findClaudeCodeUserDir();
  try {
    return fs.existsSync(userDir);
  } catch {
    return false;
  }
}

async function findClaudeMemoryDir(_projectPath: string): Promise<string | null> {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!(await dirExists(projectsDir))) return null;

  const entries = await readDir(projectsDir);
  for (const entry of entries) {
    const memoryDir = path.join(projectsDir, entry, 'memory');
    if (await dirExists(memoryDir)) {
      return memoryDir;
    }
  }

  return null;
}

async function scanUserScope(): Promise<ImportItem[]> {
  const items: ImportItem[] = [];
  const userDir = findClaudeCodeUserDir();

  const userClaudeMd = path.join(userDir, 'CLAUDE.md');
  if (await fileExists(userClaudeMd)) {
    items.push(await buildImportItem(userClaudeMd, 'user_preference', 'claude-code', 'user', 'Claude Code User Preferences'));
  }

  return items;
}

async function scanProjectScope(projectPath: string): Promise<ImportItem[]> {
  const items: ImportItem[] = [];

  const projectClaudeMd = path.join(projectPath, 'CLAUDE.md');
  if (await fileExists(projectClaudeMd)) {
    items.push(await buildImportItem(projectClaudeMd, 'project_instruction', 'claude-code', 'project', 'CLAUDE.md (Project)'));
  }

  const dotClaudeMd = path.join(projectPath, '.claude', 'CLAUDE.md');
  if (await fileExists(dotClaudeMd)) {
    items.push(await buildImportItem(dotClaudeMd, 'project_instruction', 'claude-code', 'project', '.claude/CLAUDE.md'));
  }

  const rulesDir = path.join(projectPath, '.claude', 'rules');
  if (await dirExists(rulesDir)) {
    const ruleFiles = await glob('*.md', rulesDir);
    for (const ruleFile of ruleFiles) {
      const rulePath = path.join(rulesDir, ruleFile);
      items.push(await buildImportItem(rulePath, 'project_instruction', 'claude-code', 'project', `Rule: ${ruleFile}`));
    }
  }

  const localMd = path.join(projectPath, 'CLAUDE.local.md');
  if (await fileExists(localMd)) {
    items.push(await buildImportItem(localMd, 'user_preference', 'claude-code', 'local-private', 'CLAUDE.local.md (Private)'));
  }

  const memoryDir = await findClaudeMemoryDir(projectPath);
  if (memoryDir) {
    const memFiles = await glob('*.md', memoryDir);
    for (const memFile of memFiles) {
      const memPath = path.join(memoryDir, memFile);
      items.push(await buildImportItem(memPath, 'project_memory', 'claude-code', 'project', `Memory: ${memFile}`));
    }
  }

  const skillsDir = path.join(projectPath, '.claude', 'skills');
  if (await dirExists(skillsDir)) {
    const skillDirs = await readDir(skillsDir);
    for (const dir of skillDirs) {
      const skillMd = path.join(skillsDir, dir, 'SKILL.md');
      if (await fileExists(skillMd)) {
        items.push(await buildImportItem(skillMd, 'skill', 'claude-code', 'project', `Skill: ${dir}`));
      }
    }
  }

  return items;
}

function buildSummary(items: ImportItem[]): ScanResult['summary'] {
  return {
    projectInstructions: items.filter((i) => i.type === 'project_instruction' || i.type === 'user_preference').length,
    projectMemory: items.filter((i) => i.type === 'project_memory').length,
    skills: items.filter((i) => i.type === 'skill').length,
    mcp: items.filter((i) => i.type === 'mcp').length,
    agents: items.filter((i) => i.type === 'agent').length,
    hooks: items.filter((i) => i.type === 'hook').length,
    knowledgeDocs: items.filter((i) => i.type === 'knowledge_doc').length,
    restricted: items.filter((i) => i.riskLevel === 'restricted').length,
  };
}

export async function scanClaudeCode(projectPath?: string): Promise<ScanResult> {
  const userScopeItems = await scanUserScope();
  const projectScopeItems = projectPath ? await scanProjectScope(projectPath) : [];
  const allItems = [...userScopeItems, ...projectScopeItems];

  return {
    source: 'claude-code',
    detectedInstallation: isClaudeCodeInstalled(),
    projectPath,
    userScopeItems,
    projectScopeItems,
    summary: buildSummary(allItems),
    sessions: [],
  };
}