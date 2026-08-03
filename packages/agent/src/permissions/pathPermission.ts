/**
 * Path permission checks — thin wrappers around the unified SecurityPolicy.
 *
 * Previously contained its own workspace-boundary logic and bypass-mode
 * short-circuit. That logic now lives in securityPolicy.checkPathSafety
 * so all safety decisions flow through one module.
 */

import type { PermissionCheckResult } from '../tool/types.js';
import type { ToolPermissionContext } from './types.js';
import { checkPathSafety } from './securityPolicy.js';

export function checkPathReadPermission(
  filePath: string,
  workingDirectory: string | undefined,
  toolPermissionContext: ToolPermissionContext | undefined,
): PermissionCheckResult {
  // Reads only check catastrophic paths (e.g. /dev/sda would hang or
  // return garbage). Soft blocked paths like /etc are fine to read.
  return checkPathSafety(filePath, workingDirectory, toolPermissionContext, { write: false });
}

export function checkPathWritePermission(
  filePath: string,
  workingDirectory: string | undefined,
  toolPermissionContext: ToolPermissionContext | undefined,
): PermissionCheckResult {
  return checkPathSafety(filePath, workingDirectory, toolPermissionContext, { write: true });
}
