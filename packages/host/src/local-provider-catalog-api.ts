import type { HostLocalProviderCatalogApiV1 } from '@duya/agent-protocol/provider-catalog';
import { readProviderCatalog } from './worker-config/provider-catalog.js';

/**
 * The catalog API for a Host that serves the CLI.
 *
 * The catalog is read on every call rather than cached: `config.toml` is
 * hand-edited while the app is running, and a stale catalog would offer a
 * model the next turn cannot use.
 */
export function createHostLocalProviderCatalogApi(
  configRootOverride?: string,
): HostLocalProviderCatalogApiV1 {
  return {
    async getProviderCatalog() {
      return readProviderCatalog(configRootOverride);
    },
  };
}
