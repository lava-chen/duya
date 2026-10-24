// apps/desktop/src/main/plugins/builtin-install.ts
// Builtin plugin distribution — register the plugins the installer ships.
//
// The seed puts the shipped plugin directories into the user-home cache, so
// they show up in the store. This module goes one step further: it registers
// them as *installed*, so a user who never opens the store still gets them.
//
// The install itself is the ordinary `PluginManager.installFromCatalog`
// path — same cache layout, same installed symlink, same registry entry as a
// manual install. Nothing here introduces a third kind of plugin.
//
// Two rules decide the enabled state:
//
//   - a plugin that is not registered yet starts at the manifest's
//     `defaultEnabled` (false for plugins that drive the desktop);
//   - a plugin that is already registered keeps whatever the user chose. A
//     version bump re-installs the files but never flips the switch.

import path from 'path';
import { getLogger } from '../logging/logger';
import { getPluginManager } from './PluginManager';
import { readPluginManifest } from './manifest';
import { resolveInstalledSymlink } from './cache/layout';
import {
  getBuiltinManifestPath,
  getBuiltinMarketplaceSourceDir,
  readBuiltinManifest,
} from './builtin-manifest';

const COMPONENT = 'BuiltinPluginInstall';

export interface BuiltinInstallOutcome {
  /** Newly registered plugins. */
  installed: string[];
  /** Plugins that were re-installed because the bundled version changed. */
  updated: string[];
  /** Plugins that were already installed at the bundled version. */
  unchanged: string[];
  /** Plugins that could not be registered. */
  failed: { id: string; reason: string }[];
}

function emptyOutcome(): BuiltinInstallOutcome {
  return { installed: [], updated: [], unchanged: [], failed: [] };
}

function describeError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return String(error);
}

/** Version of the copy the user actually has installed, if any. */
function readInstalledVersion(pluginId: string): string | null {
  const installPath = resolveInstalledSymlink(pluginId);
  if (!installPath) return null;
  try {
    return readPluginManifest(installPath).version || '0.1.0';
  } catch {
    return null;
  }
}

/**
 * Register the plugins declared by the builtin manifest.
 *
 * Runs after the seed, so the catalog already carries the shipped copies.
 * Every failure is contained: one broken plugin never stops the others, and
 * nothing here is allowed to reject — a distribution problem must not break
 * the app.
 */
export async function applyBuiltinPluginDefaults(): Promise<BuiltinInstallOutcome> {
  const logger = getLogger();
  const outcome = emptyOutcome();

  const manifestResult = readBuiltinManifest(getBuiltinManifestPath());
  if (manifestResult === null) {
    // No manifest shipped (a build without the marketplace repo stages no
    // plugins) — nothing to distribute.
    return outcome;
  }
  if (!manifestResult.ok) {
    logger.warn('Builtin plugin manifest is invalid; no plugin was registered', {
      error: manifestResult.error,
    }, COMPONENT);
    return outcome;
  }

  const manager = getPluginManager();
  const registered = manager.listInstalled();

  for (const declared of manifestResult.manifest.plugins) {
    const pluginDir = path.join(getBuiltinMarketplaceSourceDir(), declared.name);

    let pluginId: string;
    let bundledVersion: string;
    try {
      const pluginManifest = readPluginManifest(pluginDir);
      pluginId = pluginManifest.id;
      bundledVersion = pluginManifest.version || '0.1.0';
    } catch (err) {
      outcome.failed.push({ id: declared.name, reason: describeError(err) });
      logger.warn('Builtin plugin manifest could not be read', {
        plugin: declared.name,
        error: describeError(err),
      }, COMPONENT);
      continue;
    }

    const existing = registered.find((entry) => entry.id === pluginId);
    if (readInstalledVersion(pluginId) === bundledVersion) {
      outcome.unchanged.push(pluginId);
      continue;
    }

    // The user already made a choice about this plugin — keep it. Only a
    // plugin that was never registered starts at the manifest default.
    const shouldBeEnabled = existing?.enabled ?? declared.defaultEnabled ?? true;

    try {
      const result = await manager.installFromCatalog(pluginId);
      if (!result.success) {
        outcome.failed.push({ id: pluginId, reason: describeError(result.error) });
        logger.warn('Builtin plugin could not be installed', {
          plugin: pluginId,
          error: describeError(result.error),
        }, COMPONENT);
        continue;
      }

      // `installFromCatalog` always registers as enabled; the manifest
      // decides the initial state.
      if (!shouldBeEnabled) {
        const disabled = await manager.setEnabled(pluginId, false);
        if (!disabled.success) {
          outcome.failed.push({ id: pluginId, reason: describeError(disabled.error) });
          logger.warn('Builtin plugin could not be disabled', {
            plugin: pluginId,
            error: describeError(disabled.error),
          }, COMPONENT);
          continue;
        }
      }

      if (existing) {
        outcome.updated.push(pluginId);
      } else {
        outcome.installed.push(pluginId);
      }
      logger.info('Builtin plugin registered', {
        plugin: pluginId,
        version: bundledVersion,
        enabled: shouldBeEnabled,
        updated: Boolean(existing),
      }, COMPONENT);
    } catch (err) {
      outcome.failed.push({ id: pluginId, reason: describeError(err) });
      logger.warn('Builtin plugin registration failed', {
        plugin: pluginId,
        error: describeError(err),
      }, COMPONENT);
    }
  }

  return outcome;
}
