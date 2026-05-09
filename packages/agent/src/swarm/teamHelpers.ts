/**
 * Team file management utilities
 * Simplified version adapted from claude-code-haha for duya
 */

import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export type BackendType = 'tmux' | 'iterm2' | 'pane' | 'in_process';

export type TeamAllowedPath = {
  path: string;
  toolName: string;
  addedBy: string;
  addedAt: number;
};

export type TeamMember = {
  agentId: string;
  name: string;
  agentType?: string;
  model?: string;
  prompt?: string;
  color?: string;
  planModeRequired?: boolean;
  joinedAt: number;
  tmuxPaneId: string;
  cwd: string;
  worktreePath?: string;
  sessionId?: string;
  subscriptions: string[];
  backendType?: BackendType;
  isActive?: boolean;
  mode?: string;
};

export type TeamFile = {
  name: string;
  description?: string;
  createdAt: number;
  leadAgentId: string;
  leadSessionId?: string;
  hiddenPaneIds?: string[];
  teamAllowedPaths?: TeamAllowedPath[];
  members: TeamMember[];
};

/**
 * Sanitizes a name for use in tmux window names, worktree paths, and file paths.
 * Replaces all non-alphanumeric characters with hyphens and lowercases.
 */
export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
}

/**
 * Sanitizes an agent name for use in deterministic agent IDs.
 * Replaces @ with - to prevent ambiguity in the agentName@teamName format.
 */
export function sanitizeAgentName(name: string): string {
  return name.replace(/@/g, '-');
}

/**
 * Gets the path to a team's directory
 */
export function getTeamDir(teamName: string): string {
  const teamsDir = join(process.env.HOME || process.env.USERPROFILE || '', '.duya', 'teams');
  return join(teamsDir, sanitizeName(teamName));
}

/**
 * Gets the path to a team's config.json file
 */
export function getTeamFilePath(teamName: string): string {
  return join(getTeamDir(teamName), 'config.json');
}

/**
 * Reads a team file by name (sync)
 */
export function readTeamFile(teamName: string): TeamFile | null {
  try {
    const content = readFileSync(getTeamFilePath(teamName), 'utf-8');
    return JSON.parse(content) as TeamFile;
  } catch {
    return null;
  }
}

/**
 * Reads a team file by name (async)
 */
export async function readTeamFileAsync(teamName: string): Promise<TeamFile | null> {
  try {
    const content = await readFile(getTeamFilePath(teamName), 'utf-8');
    return JSON.parse(content) as TeamFile;
  } catch {
    return null;
  }
}

/**
 * Writes a team file (sync)
 */
function writeTeamFile(teamName: string, teamFile: TeamFile): void {
  const teamDir = getTeamDir(teamName);
  mkdirSync(teamDir, { recursive: true });
  writeFileSync(getTeamFilePath(teamName), JSON.stringify(teamFile, null, 2));
}

/**
 * Writes a team file (async)
 */
export async function writeTeamFileAsync(teamName: string, teamFile: TeamFile): Promise<void> {
  const teamDir = getTeamDir(teamName);
  await mkdir(teamDir, { recursive: true });
  await writeFile(getTeamFilePath(teamName), JSON.stringify(teamFile, null, 2));
}

/**
 * Cleans up team and task directories for a given team name.
 */
export async function cleanupTeamDirectories(teamName: string): Promise<void> {
  const sanitizedName = sanitizeName(teamName);
  const teamDir = getTeamDir(teamName);

  try {
    await rm(teamDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }

  const tasksDir = join(process.env.HOME || process.env.USERPROFILE || '', '.duya', 'tasks', sanitizedName);
  try {
    await rm(tasksDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// Stub implementations for functions that don't have equivalents in duya
export function registerTeamForSessionCleanup(_teamName: string): void {
  // No-op in duya (no session cleanup tracking)
}

export function unregisterTeamForSessionCleanup(_teamName: string): void {
  // No-op in duya
}

export function removeTeammateFromTeamFile(
  _teamName: string,
  _identifier: { agentId?: string; name?: string }
): boolean {
  return false;
}

export function setMemberMode(
  _teamName: string,
  _memberName: string,
  _mode: string
): boolean {
  return false;
}

export async function setMemberActive(
  _teamName: string,
  _memberName: string,
  _isActive: boolean
): Promise<void> {
  // No-op
}
