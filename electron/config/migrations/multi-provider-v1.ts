/**
 * multi-provider-v1 — Boot-time migration
 *
 * Moves the legacy "single active provider" model (a single
 * `ApiProvider.isActive === true` flag) into the new "soft default" model
 * (`defaultProviderId` on `AppConfig`).
 *
 * Behavior:
 *  1. If no `defaultProviderId` is set and exactly one provider has
 *     `isActive === true`, copy that provider's id into `defaultProviderId`.
 *  2. Reset `isActive` to `false` on every provider. The new `isDefault`
 *     derivation is now the only authoritative state.
 *  3. Mark the migration done via `migrations['multi-provider-v1'] = true`
 *     so it never re-runs.
 *
 * The marker is read from the in-memory config. Because `migrations` is part
 * of `AppConfig` and survives the `mergeWithDefault` round-trip, the marker
 * also persists across reboots.
 */

import { LogComponent, getLogger } from '../../logging/logger';
import type { ConfigManager, ApiProvider } from '../manager';

const MARKER = 'multi-provider-v1';
const log = getLogger();

export function migrateMultiProviderV1(configManager: ConfigManager): void {
  const cfg = configManager.getConfig() as { migrations?: Record<string, boolean> };
  if (cfg.migrations?.[MARKER]) {
    return;
  }

  const providers = Object.values(configManager.getAllProviders()) as Array<
    ApiProvider & { isActive?: boolean }
  >;
  const activeProviders = providers.filter((p) => p.isActive === true);

  if (!configManager.getDefaultProvider() && activeProviders.length === 1) {
    const winner = activeProviders[0]!;
    configManager.setDefaultProvider(winner.id);
    log.info(
      'multi-provider-v1: migrated defaultProviderId from single isActive',
      { providerId: winner.id },
      LogComponent.ConfigManager,
    );
  } else if (activeProviders.length === 0) {
    log.info(
      'multi-provider-v1: no active provider found; defaultProviderId stays null',
      {},
      LogComponent.ConfigManager,
    );
  } else {
    log.warn(
      'multi-provider-v1: multiple active providers detected; not auto-migrating',
      { count: activeProviders.length },
      LogComponent.ConfigManager,
    );
  }

  // Reset isActive on every provider regardless of how the default was chosen.
  let mutated = false;
  for (const p of providers) {
    if (p.isActive !== false) {
      configManager.upsertProvider({ ...p, isActive: false });
      mutated = true;
    }
  }
  if (mutated) {
    log.info('multi-provider-v1: reset all isActive flags', {}, LogComponent.ConfigManager);
  }

  // Persist the marker. Use the 'main' role so the permission check allows it.
  const nextMigrations = { ...(cfg.migrations ?? {}), [MARKER]: true };
  configManager.setConfig('migrations', nextMigrations, 'main');
}
