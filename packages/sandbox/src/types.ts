/**
 * Sandbox Types
 *
 * Core type definitions for the cross-platform sandbox system.
 */

export type SandboxProvider = 'docker' | 'bubblewrap' | 'none';

export interface SandboxPolicy {
  mode: 'strict' | 'permissive' | 'off';
  filesystem: {
    allowRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
  network: 'none' | 'restricted' | 'full';
  memoryLimitMb: number;
  timeoutSeconds: number;
}

export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = {
  mode: 'strict',
  filesystem: {
    allowRead: [],
    allowWrite: [],
    denyWrite: ['/etc', '/sys', '/proc', '/dev'],
  },
  network: 'none',
  memoryLimitMb: 512,
  timeoutSeconds: 300,
};

export function createSandboxPolicy(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    ...DEFAULT_SANDBOX_POLICY,
    ...overrides,
    filesystem: {
      ...DEFAULT_SANDBOX_POLICY.filesystem,
      ...overrides.filesystem,
    },
  };
}