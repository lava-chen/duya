import type {
  PluginUiSurface,
  PluginUiSurfaceDirectory,
  PluginUiSurfaceDirectoryEntry,
} from '@duya/plugin-core/apps/declarations';

interface InstalledPluginSurfaceSource {
  id: string;
  name: string;
  enabled: boolean;
  apps?: ReadonlyArray<{
    appId: string;
    ui?: { surfaces: ReadonlyArray<PluginUiSurface> };
  }>;
}

/** Project installed Plugin App metadata into the host's enabled surface directory. */
export function buildPluginUiSurfaceDirectory(
  plugins: readonly InstalledPluginSurfaceSource[],
): PluginUiSurfaceDirectory {
  const candidates = new Map<string, Array<{ entry: PluginUiSurfaceDirectoryEntry; enabled: boolean }>>();

  for (const plugin of plugins) {
    for (const app of plugin.apps ?? []) {
      for (const surface of app.ui?.surfaces ?? []) {
        const entry: PluginUiSurfaceDirectoryEntry = {
          ...surface,
          pluginId: plugin.id,
          pluginName: plugin.name,
          appId: app.appId,
        };
        const owners = candidates.get(surface.id) ?? [];
        owners.push({ entry, enabled: plugin.enabled });
        candidates.set(surface.id, owners);
      }
    }
  }

  const surfaces: PluginUiSurfaceDirectoryEntry[] = [];
  const conflicts: PluginUiSurfaceDirectory['conflicts'] = [];
  for (const [id, candidatesForId] of candidates) {
    if (candidatesForId.length > 1) {
      conflicts.push({
        id,
        owners: candidatesForId
          .map(({ entry }) => ({
            pluginId: entry.pluginId,
            pluginName: entry.pluginName,
            appId: entry.appId,
          }))
          .sort(compareOwner),
      });
      continue;
    }

    const [candidate] = candidatesForId;
    if (candidate?.enabled) {
      surfaces.push(candidate.entry);
    }
  }

  surfaces.sort((left, right) => left.id.localeCompare(right.id));
  conflicts.sort((left, right) => left.id.localeCompare(right.id));
  return { surfaces, conflicts };
}

function compareOwner(
  left: { pluginId: string; pluginName: string; appId: string },
  right: { pluginId: string; pluginName: string; appId: string },
): number {
  return left.pluginId.localeCompare(right.pluginId) || left.appId.localeCompare(right.appId);
}
