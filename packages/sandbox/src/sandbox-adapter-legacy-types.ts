/**
 * Legacy types from the original sandbox-adapter.ts
 * Kept for backward compatibility with ISandboxManager interface.
 */

export type SandboxRuntimeConfig = {
  network?: {
    allowedDomains?: string[];
    deniedDomains?: string[];
    allowUnixSockets?: boolean;
    allowAllUnixSockets?: boolean;
    allowLocalBinding?: boolean;
  };
  filesystem?: {
    denyRead?: string[];
    allowRead?: string[];
    allowWrite?: string[];
    denyWrite?: string[];
  };
  ignoreViolations?: string[];
  enableWeakerNestedSandbox?: boolean;
  enableWeakerNetworkIsolation?: boolean;
};