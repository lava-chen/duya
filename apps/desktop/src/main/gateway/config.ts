import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';
import type { GatewayInitConfig } from './types';

/**
 * Default gateway workspace when `bridge_workspace` setting is absent.
 * Resolves to ~/.duya/workspace (user home based).
 */
export function getDefaultGatewayWorkspace(): string {
  return join(homedir(), '.duya', 'workspace');
}

/**
 * Resolve the gateway working directory from its already-resolved Host config,
 * falling back to ~/.duya/workspace.
 *
 * Expands leading ~ to the user home dir. Empty string falls back to default.
 */
export function resolveGatewayWorkspace(initConfig?: GatewayInitConfig): string {
  const raw = initConfig?.workingDirectory;
  if (!raw) return getDefaultGatewayWorkspace();
  if (raw.startsWith('~/') || raw === '~') {
    return join(homedir(), raw.slice(1));
  }
  return raw;
}

/** Resolve and create the gateway workspace before a worker uses it as cwd. */
export function prepareGatewayWorkspace(initConfig?: GatewayInitConfig): string {
  const workspace = resolveGatewayWorkspace(initConfig);
  mkdirSync(workspace, { recursive: true });
  return workspace;
}
