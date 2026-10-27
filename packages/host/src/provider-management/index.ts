/**
 * provider-management — the Host's write side of `[providers.*]`.
 *
 * The catalog next door (`worker-config/provider-catalog.ts`) reads the same
 * tables to answer "what can I pick"; this directory answers "what is
 * configured, and change it". Split by concern: `provider-files.ts` owns the
 * two files and their revision, `remote-probe.ts` owns the one network call,
 * `management-api.ts` owns the rules.
 */

export {
  HostProviderApiError,
  allocateProviderId,
  createHostLocalProviderManagementApi,
  normalizeWrite,
} from './management-api.js';
export type {
  NormalizedWrite,
  ProviderManagementOptions,
} from './management-api.js';
export {
  ProviderFileError,
  dropProviderSecret,
  providerFilePaths,
  providerSecretPath,
  readProviderSnapshot,
  revisionOf,
  writeProviderTables,
} from './provider-files.js';
export type {
  ProviderEntryTable,
  ProviderFiles,
  ProviderSnapshot,
} from './provider-files.js';
export { candidatePaths, parseModelList, probeProvider, redactBaseUrl } from './remote-probe.js';
export type { ProbeOptions, ProbeOutcome, ProbeTarget } from './remote-probe.js';
