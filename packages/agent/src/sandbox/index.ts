/**
 * Sandbox System for duya Agent
 *
 * Provides cross-platform sandbox execution for commands with filesystem
 * and network restrictions.
 *
 * Provider priority: Docker → bubblewrap → none (regex-only)
 */

export {
  getActiveProvider,
  executeIsolated,
  wrapCommand,
  setSandboxEnabled,
  isSandboxEnabled,
  getSandboxPolicy,
  updateSandboxPolicy,
  resetProviderCache,
  SandboxManager,
  addExcludedCommand,
} from './sandbox-adapter.js';

export {
  checkDockerAvailable,
  executeInDocker,
  ensureSandboxImage,
  buildSandboxImage,
  resetDockerAvailability,
} from './docker-sandbox.js';

export {
  checkBubblewrapAvailable,
  wrapWithBubblewrap,
  resetBubblewrapAvailability,
} from './bubblewrap-sandbox.js';

export {
  createSandboxPolicy,
  DEFAULT_SANDBOX_POLICY,
} from './types.js';

export type {
  SandboxPolicy,
  SandboxProvider,
} from './types.js';

export type {
  SandboxExecuteResult,
  ISandboxManager,
  FsReadRestrictionConfig,
  FsWriteRestrictionConfig,
  NetworkHostPattern,
  NetworkRestrictionConfig,
  SandboxAskCallback,
  SandboxDependencyCheck,
  SandboxViolationEvent,
  SandboxViolationStore,
} from './sandbox-adapter.js';

export type {
  SandboxRuntimeConfig,
} from './sandbox-adapter-legacy-types.js';