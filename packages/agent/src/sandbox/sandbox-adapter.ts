/**
 * Sandbox Orchestrator
 *
 * Unified sandbox adapter that selects the best available provider:
 *   1. Docker container (cross-platform, true isolation)
 *   2. bubblewrap (Linux-only, lightweight)
 *   3. None (regex-only defense in BashTool)
 *
 * Exposes both wrapping (bubblewrap) and execution (Docker) APIs.
 */

import type { SandboxPolicy, SandboxProvider } from './types.js';
import { createSandboxPolicy } from './types.js';
import {
  checkBubblewrapAvailable,
  isBubblewrapPlatform,
  wrapWithBubblewrap,
  resetBubblewrapAvailability,
} from './bubblewrap-sandbox.js';
import {
  checkDockerAvailable,
  executeInDocker,
  resetDockerAvailability,
} from './docker-sandbox.js';

// State
let isEnabled = true;
let policy: SandboxPolicy = createSandboxPolicy();

// ============================================================
// Provider Selection
// ============================================================

let cachedProvider: { provider: SandboxProvider; checkedAt: number } | null = null;
const PROVIDER_CACHE_MS = 30000;

/**
 * Determine the active sandbox provider.
 * Cached for 30s to avoid repeated daemon pings.
 */
export async function getActiveProvider(): Promise<SandboxProvider> {
  if (cachedProvider && (Date.now() - cachedProvider.checkedAt) < PROVIDER_CACHE_MS) {
    return cachedProvider.provider;
  }

  if (!isEnabled) {
    cachedProvider = { provider: 'none', checkedAt: Date.now() };
    return 'none';
  }

  // 1. Try Docker (cross-platform)
  if (await checkDockerAvailable()) {
    cachedProvider = { provider: 'docker', checkedAt: Date.now() };
    return 'docker';
  }

  // 2. Try bubblewrap (Linux only)
  if (isBubblewrapPlatform() && checkBubblewrapAvailable()) {
    cachedProvider = { provider: 'bubblewrap', checkedAt: Date.now() };
    return 'bubblewrap';
  }

  // 3. No sandbox available
  cachedProvider = { provider: 'none', checkedAt: Date.now() };
  return 'none';
}

/**
 * Force re-evaluate provider on next call
 */
export function resetProviderCache(): void {
  cachedProvider = null;
  resetDockerAvailability();
  resetBubblewrapAvailability();
}

// ============================================================
// Command Execution
// ============================================================

export interface SandboxExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  provider: SandboxProvider;
}

/**
 * Execute a command with Docker isolation.
 * Returns the command output directly (Docker handles execution).
 */
export async function executeIsolated(
  command: string,
  cwd: string,
  overrides?: Partial<SandboxPolicy>,
  signal?: AbortSignal,
): Promise<SandboxExecuteResult> {
  const effectivePolicy = overrides
    ? createSandboxPolicy(overrides)
    : policy;

  const result = await executeInDocker({
    command,
    cwd,
    policy: effectivePolicy,
    signal,
  });

  return {
    ...result,
    provider: 'docker',
  };
}

/**
 * Wrap a command for execution with shell-based sandboxes (bubblewrap or none).
 * Returns the command string to pass to execa.
 *
 * - bubblewrap: wraps command in `bwrap --ro-bind / / ... -- cmd`
 * - none: returns command unchanged (regex defense still active)
 */
export async function wrapCommand(
  command: string,
  cwd: string,
  overrides?: Partial<SandboxPolicy>,
): Promise<string> {
  const provider = await getActiveProvider();

  if (provider === 'bubblewrap') {
    const effectivePolicy = overrides
      ? createSandboxPolicy(overrides)
      : policy;
    return wrapWithBubblewrap(command, cwd, effectivePolicy);
  }

  // 'docker' provides its own execution path (executeIsolated)
  // 'none' returns the command as-is (BashTool regex defense active)
  return command;
}

// ============================================================
// Configuration
// ============================================================

export function setSandboxEnabled(enabled: boolean): void {
  isEnabled = enabled;
  resetProviderCache();
}

export function isSandboxEnabled(): boolean {
  return isEnabled;
}

export function getSandboxPolicy(): SandboxPolicy {
  return policy;
}

export function updateSandboxPolicy(updates: Partial<SandboxPolicy>): void {
  policy = createSandboxPolicy({
    ...policy,
    ...updates,
    filesystem: {
      ...policy.filesystem,
      ...updates.filesystem,
    },
  });
}

// ============================================================
// Legacy Compatibility API (ISandboxManager)
// ============================================================

import type { SandboxRuntimeConfig } from './sandbox-adapter-legacy-types.js';

export type FsReadRestrictionConfig = {
  deny?: string[];
  allow?: string[];
};

export type FsWriteRestrictionConfig = {
  allow?: string[];
  deny?: string[];
};

export type NetworkHostPattern = {
  host: string;
  port?: number;
};

export type NetworkRestrictionConfig = {
  allowedDomains?: string[];
  deniedDomains?: string[];
  allowUnixSockets?: boolean;
  allowAllUnixSockets?: boolean;
  allowLocalBinding?: boolean;
};

export type SandboxAskCallback = (
  hostPattern: NetworkHostPattern,
) => Promise<boolean>;

export type SandboxDependencyCheck = {
  errors: string[];
  warnings: string[];
};

export type SandboxViolationEvent = {
  type: 'network' | 'filesystem';
  operation: string;
  path?: string;
  host?: string;
};

export type SandboxViolationStore = {
  getViolations(): SandboxViolationEvent[];
  clearViolations(): void;
};

let excludedCommands: string[] = [];
let violationStore: SandboxViolationStore = {
  getViolations: () => [],
  clearViolations: () => {},
};
let isInitialized = false;

function isSandboxingEnabled(): boolean {
  return isEnabled && isInitialized;
}

function isCommandExcluded(command: string): boolean {
  return excludedCommands.some(excluded =>
    command.startsWith(excluded) || command.includes(excluded),
  );
}

async function wrapWithSandboxLegacy(
  command: string,
  _binShell?: string,
  _customConfig?: Partial<SandboxRuntimeConfig>,
  _abortSignal?: AbortSignal,
): Promise<string> {
  if (!isSandboxingEnabled()) return command;
  if (isCommandExcluded(command)) return command;

  const provider = await getActiveProvider();
  if (provider === 'docker') {
    // Docker handles execution separately — return original command
    // BashTool will use executeIsolated() instead
    return command;
  }
  if (provider === 'bubblewrap') {
    return wrapWithBubblewrap(command, process.cwd(), policy);
  }
  return command;
}

async function initialize(_config?: SandboxRuntimeConfig, _sandboxAskCallback?: SandboxAskCallback): Promise<void> {
  isInitialized = true;
}

function getFsReadConfig(): FsReadRestrictionConfig {
  return {};
}

function getFsWriteConfig(): FsWriteRestrictionConfig {
  return {};
}

function getNetworkRestrictionConfig(): NetworkRestrictionConfig {
  return {};
}

function cleanupAfterCommand(): void {
  violationStore.clearViolations();
}

export interface ISandboxManager {
  initialize(config?: SandboxRuntimeConfig, sandboxAskCallback?: SandboxAskCallback): Promise<void>;
  isSupportedPlatform(): boolean;
  isSandboxingEnabled(): boolean;
  isSandboxEnabledInSettings(): boolean;
  checkDependencies(): SandboxDependencyCheck;
  isAutoAllowBashIfSandboxedEnabled(): boolean;
  getExcludedCommands(): string[];
  wrapWithSandbox(
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
  ): Promise<string>;
  cleanupAfterCommand(): void;
  getSandboxViolationStore(): SandboxViolationStore;
  refreshConfig(): void;
  reset(): Promise<void>;
  getFsReadConfig(): FsReadRestrictionConfig;
  getFsWriteConfig(): FsWriteRestrictionConfig;
  getNetworkRestrictionConfig(): NetworkRestrictionConfig;
}

export const SandboxManager: ISandboxManager = {
  initialize,
  isSandboxingEnabled,
  isSandboxEnabledInSettings: () => isEnabled,
  isSupportedPlatform: () => true,
  checkDependencies: () => ({ errors: [], warnings: [] }),
  isAutoAllowBashIfSandboxedEnabled: () => true,
  getExcludedCommands: () => excludedCommands,
  wrapWithSandbox: wrapWithSandboxLegacy,
  cleanupAfterCommand,
  getSandboxViolationStore: () => violationStore,
  refreshConfig: () => {},
  reset: async () => {
    isInitialized = false;
    excludedCommands = [];
    resetProviderCache();
    violationStore.clearViolations();
  },
  getFsReadConfig,
  getFsWriteConfig,
  getNetworkRestrictionConfig,
};

export function addExcludedCommand(command: string): void {
  if (!excludedCommands.includes(command)) {
    excludedCommands.push(command);
  }
}