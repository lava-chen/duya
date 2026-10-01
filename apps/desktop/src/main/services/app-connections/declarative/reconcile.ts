/**
 * Plugin connector declaration reconciler — Plan 460.
 *
 * Bridges the plugin system and the app-connection layer: after plugins
 * are installed/enabled (or at startup), scan every enabled plugin's
 * `.app.json` and register its connector declarations into the connector
 * service (dual-registration: provider config + connector registry). This
 * is what makes "extend duya's app capabilities purely by publishing a
 * marketplace plugin" work — a plugin author ships `.app.json` with oauth
 * endpoints + REST tool templates, and the connector comes alive without
 * any duya core change.
 *
 * Call sites:
 *   - app startup (full reconcile)
 *   - plugin:install / plugin:install-local / plugin:enable → reconcile one
 *   - plugin:disable / plugin:remove → unregister one
 */

import fs from 'fs';
import path from 'path';
import { getLogger, LogComponent } from '../../../logging/logger';
import { getPluginManager } from '../../../plugins/PluginManager.js';
import { getConnectorService } from '../connector-service.js';
import { parseAppDeclarationFile } from '@duya/plugin-core/src/connectors/app-schema.js';

const COMPONENT = 'AppConnectionReconcile' as LogComponent;

function connectorSourceOf(pluginId: string): string {
  return `plugin:${pluginId}`;
}

/** Full reconcile: register declarations for every enabled plugin. */
export function reconcilePluginAppDeclarations(): {
  registered: number;
  skipped: number;
  errors: string[];
} {
  const logger = getLogger();
  const manager = getPluginManager();
  const connectorService = getConnectorService();
  let registered = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const item of manager.listInstalled()) {
    if (!item.enabled || !item.installPath) continue;
    const outcome = registerPlugin(item.id, item.installPath);
    registered += outcome.registered;
    skipped += outcome.skipped;
    errors.push(...outcome.errors);
  }

  if (registered > 0 || skipped > 0 || errors.length > 0) {
    logger.info(
      'App Connection: reconciled plugin app declarations',
      { registered, skipped, errors: errors.length },
      COMPONENT,
    );
  }
  return { registered, skipped, errors };
}

/** Register one plugin's declarations (install/enable/startup single). */
export function reconcilePluginAppDeclarationsFor(pluginId: string): void {
  const item = getPluginManager().listInstalled().find((p) => p.id === pluginId);
  if (!item || !item.enabled || !item.installPath) return;
  registerPlugin(item.id, item.installPath);
}

/** Unregister one plugin's declarations (disable/remove). */
export function unregisterPluginAppDeclarations(pluginId: string): void {
  getConnectorService().unregisterPluginAppDeclarations(connectorSourceOf(pluginId));
}

function registerPlugin(
  pluginId: string,
  installPath: string,
): { registered: number; skipped: number; errors: string[] } {
  const appJsonPath = path.join(installPath, '.app.json');
  if (!fs.existsSync(appJsonPath)) {
    return { registered: 0, skipped: 0, errors: [] };
  }
  const source = connectorSourceOf(pluginId);
  try {
    const parsed = parseAppDeclarationFile(fs.readFileSync(appJsonPath, 'utf8'));
    if (!parsed.ok) {
      getLogger().warn(
        'App Connection: plugin .app.json rejected',
        { pluginId, reason: parsed.reason },
        COMPONENT,
      );
      return { registered: 0, skipped: 1, errors: [] };
    }
    const out = getConnectorService().registerPluginAppDeclarations(source, parsed.apps);
    return {
      registered: out.registered.length,
      skipped: out.skipped.length,
      errors: out.skipped.map((s) => `${pluginId}: ${s.id} — ${s.reason}`),
    };
  } catch (err) {
    getLogger().warn(
      'App Connection: plugin .app.json read failed',
      err instanceof Error ? err : new Error(String(err)),
      { pluginId },
      COMPONENT,
    );
    return { registered: 0, skipped: 0, errors: [`${pluginId}: ${err instanceof Error ? err.message : String(err)}`] };
  }
}
