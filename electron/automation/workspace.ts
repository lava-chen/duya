import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function getDefaultAutomationWorkspace(): string {
  return join(homedir(), '.duya', 'workspace');
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
