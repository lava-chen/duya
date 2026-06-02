import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { PermissionCheckResult } from '../tool/types.js';
import { isBypassMode } from './PermissionMode.js';
import type { ToolPermissionContext } from './types.js';
import { expandPath } from '../utils/path.js';

export function checkPathReadPermission(
  filePath: string,
  workingDirectory: string | undefined,
  toolPermissionContext: ToolPermissionContext | undefined,
): PermissionCheckResult {
  return checkPathPermission(filePath, workingDirectory, toolPermissionContext);
}

export function checkPathWritePermission(
  filePath: string,
  workingDirectory: string | undefined,
  toolPermissionContext: ToolPermissionContext | undefined,
): PermissionCheckResult {
  return checkPathPermission(filePath, workingDirectory, toolPermissionContext);
}

function checkPathPermission(
  filePath: string,
  workingDirectory: string | undefined,
  toolPermissionContext: ToolPermissionContext | undefined,
): PermissionCheckResult {
  if (toolPermissionContext && isBypassMode(toolPermissionContext.mode)) {
    return { allowed: true };
  }

  if (!workingDirectory) {
    return { allowed: true };
  }

  const resolvedPath = expandPath(filePath, workingDirectory);

  const resolvedWorkingDir = resolve(workingDirectory);
  let normalizedWorkingDir = resolvedWorkingDir.replace(/\\/g, '/');
  let normalizedFilePath = resolvedPath.replace(/\\/g, '/');

  if (process.platform === 'win32') {
    normalizedWorkingDir = normalizedWorkingDir.toLowerCase();
    normalizedFilePath = normalizedFilePath.toLowerCase();
  }

  const workingDirPrefix = normalizedWorkingDir.endsWith('/')
    ? normalizedWorkingDir
    : normalizedWorkingDir + '/';

  const isInWorkingDir = normalizedFilePath.startsWith(workingDirPrefix) || normalizedFilePath === normalizedWorkingDir;

  if (isInWorkingDir) {
    return { allowed: true };
  }

  const homeDir = homedir();
  const normalizedHomeDir = (process.platform === 'win32' ? homeDir.toLowerCase() : homeDir).replace(/\\/g, '/');
  const skillsDirPrefix = normalizedHomeDir + '/.duya/skills/';
  const isSkillFile = normalizedFilePath.startsWith(skillsDirPrefix) || normalizedFilePath === skillsDirPrefix.slice(0, -1);

  if (isSkillFile) {
    return { allowed: true };
  }

  if (toolPermissionContext?.additionalWorkingDirectories) {
    for (const [dirPath] of toolPermissionContext.additionalWorkingDirectories) {
      const resolvedAdditionalDir = resolve(dirPath);
      let normalizedAdditionalDir = resolvedAdditionalDir.replace(/\\/g, '/');
      if (process.platform === 'win32') {
        normalizedAdditionalDir = normalizedAdditionalDir.toLowerCase();
      }
      const additionalDirPrefix = normalizedAdditionalDir.endsWith('/')
        ? normalizedAdditionalDir
        : normalizedAdditionalDir + '/';
      if (normalizedFilePath.startsWith(additionalDirPrefix) || normalizedFilePath === normalizedAdditionalDir) {
        return { allowed: true };
      }
    }
  }

  return {
    allowed: true,
    requiresUserConfirmation: true,
    reason: 'Path outside working directory',
  };
}