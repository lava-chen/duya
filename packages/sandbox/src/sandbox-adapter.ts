/**
 * Sandbox Orchestrator
 *
 * Unified sandbox adapter that selects the best available provider:
 *   1. Docker container (cross-platform, true isolation)
 *   2. bubblewrap (Linux-only, lightweight)
 *   3. None (regex-only defense in BashTool)
 *
 * Exposes both wrapping (bubblewrap) and execution (Docker) APIs.
 *
 * ## Two questions, not one
 *
 * `getActiveProvider()` answers "which provider is AVAILABLE". The shell
 * execution path needs a different answer: "will the command I am about to
 * spawn be ISOLATED".
 *
 * The two are not the same, and conflating them is how a system ends up
 * claiming isolation it does not have. The Docker provider is selected by
 * availability, but Docker is applied by `executeIsolated` — a command that is
 * only WRAPPED and then spawned locally runs with no container around it. So a
 * shell path that reported "docker" would be reporting a provider it never
 * applied.
 *
 * `resolveShellIsolation()` therefore answers the second question, and it only
 * ever answers "bubblewrap" or "none": the two levels the shell path can
 * actually deliver. `none` is not a failure — it is the truth on a host with
 * no OS isolation available, and it is reported as such instead of being
 * dressed up as a downgrade.
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
  cachedShellIsolation = null;
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
  timedOut?: boolean;
}

/**
 * What the SHELL EXECUTION PATH can actually deliver.
 *
 * `bubblewrap` is applied by wrapping the command, so it is real isolation
 * for a command that is spawned locally. `none` means the command runs
 * unwrapped: the regex and path-root defenses still apply, and nothing else
 * does.
 */
export type ShellIsolationProvider = 'bubblewrap' | 'none';

/**
 * The isolation level in force for a command about to be run.
 *
 * `isolated` is the claim; `reason` is why the claim is what it is. A reader
 * of a run row needs both: "bubblewrap" alone does not say whether the level
 * was chosen or merely available, and `reason` is where a host with no
 * isolation provider says so in words.
 */
export interface ShellIsolation {
  readonly provider: ShellIsolationProvider;
  /** True only when the command will actually run inside an OS sandbox. */
  readonly isolated: boolean;
  /** Why this level, in words a user can read. */
  readonly reason: string;
}

const NO_ISOLATION_DISABLED: ShellIsolation = {
  provider: 'none',
  isolated: false,
  reason: 'command sandboxing is disabled for this run',
};

const NO_ISOLATION_UNAVAILABLE: ShellIsolation = {
  provider: 'none',
  isolated: false,
  reason: 'no OS isolation provider is available on this host, so the command runs unwrapped',
};

const BUBBLEWRAP_ISOLATION: ShellIsolation = {
  provider: 'bubblewrap',
  isolated: true,
  reason: 'the command runs inside a bubblewrap sandbox',
};

let cachedShellIsolation: ShellIsolation | null = null;

/**
 * The isolation level the shell path can deliver, resolved synchronously.
 *
 * Synchronous because the Control Plane has to record the level on a run
 * manifest, and a manifest is assembled in one synchronous call. Bubblewrap's
 * availability check is synchronous, so nothing is lost by that: Docker is
 * irrelevant here, because the shell path never applies Docker.
 */
export function resolveShellIsolationSync(): ShellIsolation {
  if (!isEnabled) {
    cachedShellIsolation = NO_ISOLATION_DISABLED;
    return cachedShellIsolation;
  }
  if (isBubblewrapPlatform() && checkBubblewrapAvailable()) {
    cachedShellIsolation = BUBBLEWRAP_ISOLATION;
    return cachedShellIsolation;
  }
  cachedShellIsolation = NO_ISOLATION_UNAVAILABLE;
  return cachedShellIsolation;
}

/**
 * The isolation level the shell path can deliver.
 *
 * The asynchronous form exists for callers that already await; it resolves to
 * exactly what {@link resolveShellIsolationSync} resolves to.
 */
export async function resolveShellIsolation(): Promise<ShellIsolation> {
  return resolveShellIsolationSync();
}

/**
 * The last resolved isolation level, or `null` when nothing has resolved one
 * yet in this process.
 *
 * `null` means "not resolved", which is different from "resolved as none" and
 * must not be reported as either.
 */
export function getCachedShellIsolation(): ShellIsolation | null {
  return cachedShellIsolation;
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
  timeoutMs?: number,
): Promise<SandboxExecuteResult> {
  const effectivePolicy = overrides
    ? createSandboxPolicy(overrides)
    : policy;

  const result = await executeInDocker({
    command,
    cwd,
    policy: effectivePolicy,
    signal,
    timeoutMs,
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
 *
 * The Docker provider is deliberately NOT honoured here: wrapping cannot
 * create a container, so a wrapped command under Docker would run unwrapped
 * while the caller believed it was isolated. Use {@link executeIsolated} for
 * Docker.
 */
export async function wrapCommand(
  command: string,
  cwd: string,
  overrides?: Partial<SandboxPolicy>,
): Promise<string> {
  return wrapCommandSync(command, cwd, overrides);
}

/**
 * The synchronous form of {@link wrapCommand}.
 *
 * Nothing inside the wrap is asynchronous, so the asynchronous form was
 * costing a microtask hop on a path that a shell worker has to take before it
 * can spawn anything.
 */
export function wrapCommandSync(
  command: string,
  cwd: string,
  overrides?: Partial<SandboxPolicy>,
): string {
  const isolation = resolveShellIsolationSync();

  if (isolation.provider === 'bubblewrap') {
    const effectivePolicy = overrides
      ? createSandboxPolicy(overrides)
      : policy;
    return wrapWithBubblewrap(command, cwd, effectivePolicy);
  }

  // 'none' returns the command as-is (the caller's regex defense stays active)
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

  // The legacy manager wraps commands the same way the shell path does, so it
  // asks the same question. It used to consult `getActiveProvider()`, which
  // answers "docker" on a host with Docker — and a wrapped command is never
  // run in a container, so that answer was a guarantee the caller could not
  // cash.
  const isolation = resolveShellIsolationSync();
  if (isolation.provider === 'bubblewrap') {
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