/**
 * Team memory paths management.
 * Adapted from claude-code-haha memdir/teamMemPaths.ts
 */

import { lstat, realpath } from 'fs/promises'
import { dirname, join, resolve, sep } from 'path'
import { getAutoMemPath, isAutoMemoryEnabled } from './paths.js'

/**
 * Error thrown when a path validation detects a traversal or injection attempt.
 */
export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathTraversalError'
  }
}

/**
 * Whether team memory features are enabled.
 * Team memory is a subdirectory of auto memory, so it requires auto memory
 * to be enabled.
 */
export function isTeamMemoryEnabled(): boolean {
  if (!isAutoMemoryEnabled()) {
    return false
  }
  // Team memory feature flag - could be controlled by env var or settings
  return process.env.duya_TEAM_MEMORY_ENABLED === 'true'
}

/**
 * Returns the team memory path: <memoryBase>/projects/<sanitized-project-root>/memory/team/
 * Lives as a subdirectory of the auto-memory directory, scoped per-project.
 */
export function getTeamMemPath(): string {
  return (join(getAutoMemPath(), 'team') + sep).normalize('NFC')
}

/**
 * Returns the team memory entrypoint: <memoryBase>/projects/<sanitized-project-root>/memory/team/MEMORY.md
 */
export function getTeamMemEntrypoint(): string {
  return join(getAutoMemPath(), 'team', 'MEMORY.md')
}

/**
 * Check if a resolved absolute path is within the team memory directory.
 */
export function isTeamMemPath(filePath: string): boolean {
  const resolvedPath = resolve(filePath)
  const teamDir = getTeamMemPath()
  return resolvedPath.startsWith(teamDir)
}

/**
 * Check if a file path is within the team memory directory
 * and team memory is enabled.
 */
export function isTeamMemFile(filePath: string): boolean {
  return isTeamMemoryEnabled() && isTeamMemPath(filePath)
}
