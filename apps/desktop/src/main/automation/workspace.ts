import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function getDefaultAutomationWorkspace(): string {
  return join(homedir(), '.duya', 'workspace');
}

/**
 * Canonical path of the shared "no-project" workspace (`~/.duya/workspace`).
 * Creates the directory if missing and resolves symlinks/case via
 * `realpathSync.native` so frontend grouping matches regardless of how the
 * path was spelled when the session was created.
 */
export function getNoProjectWorkspace(): string {
  const workspace = getDefaultAutomationWorkspace();
  mkdirSync(workspace, { recursive: true });
  return realpathSync.native(workspace);
}

export function resolveAutomationWorkspace(value?: string | null): string {
  const raw = value?.trim();
  if (!raw) return getDefaultAutomationWorkspace();
  if (raw === '~') return homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return join(homedir(), raw.slice(2));
  }
  return raw;
}

export function prepareAutomationWorkspace(value?: string | null): string {
  const workspace = resolveAutomationWorkspace(value);
  mkdirSync(workspace, { recursive: true });
  return workspace;
}
