export { withPluginError, withPluginErrorSync, isSuccess, isFailure, unwrapResult, unwrapOr } from './error-wrapper';
export type { PluginResult } from './error-wrapper';

export {
  PathSafetyValidator,
} from './security/path-validator';
export type { PathValidationResult } from './security/path-validator';

export {
  PluginTrustLevel,
  TrustEngine,
  TRUST_LEVEL_CAPABILITIES,
} from './security/trust-engine';
export type { PluginTrustInfo, TrustLevelCapability } from './security/trust-engine';

export {
  PermissionService,
} from './security/permission-service';
export type {
  PermissionRequest,
  GrantedPermission,
  PermissionCheckResult,
} from './security/permission-service';

export {
  PolicyEngine,
  DEFAULT_POLICY,
} from './security/policy-engine';
export type { EnterprisePolicy } from './security/policy-engine';

export {
  PluginSecretStore,
} from './security/secret-store';
export type { SecretEntry } from './security/secret-store';

export {
  isPluginError,
  toPluginError,
} from './types';
export type {
  PluginError,
  PluginInstallError,
  PluginManifestError,
  PluginRuntimeError,
  PluginMarketplaceError,
  PluginCompatError,
} from './types';