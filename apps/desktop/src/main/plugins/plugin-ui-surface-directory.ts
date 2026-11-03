import type {
  PluginAppPlacement,
  PluginAppPlacementSlot,
  PluginUiPlacementDirectoryEntry,
  PluginUiSurface,
  PluginUiSurfaceDirectory,
  PluginUiSurfaceDirectoryEntry,
} from '@duya/plugin-core/apps/declarations';

interface InstalledApp {
  appId: string;
  runtime?: 'agent-run' | 'standalone';
  ui?: {
    surfaces?: ReadonlyArray<PluginUiSurface>;
    placements?: ReadonlyArray<PluginAppPlacement>;
  };
}

interface InstalledPluginSurfaceSource {
  id: string;
  name: string;
  enabled: boolean;
  apps?: ReadonlyArray<InstalledApp>;
}

/** Order the host renders slots in; also the directory's sort order. */
const SLOT_ORDER: readonly PluginAppPlacementSlot[] = ['sidebar.item', 'session.panel'];

/** Project installed Plugin App metadata into the host's enabled directory. */
export function buildPluginUiSurfaceDirectory(
  plugins: readonly InstalledPluginSurfaceSource[],
): PluginUiSurfaceDirectory {
  const candidates = new Map<string, Array<{ entry: PluginUiSurfaceDirectoryEntry; enabled: boolean }>>();
  const placements: PluginUiPlacementDirectoryEntry[] = [];

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

      // A disabled plugin contributes no entries at all: the point of
      // disabling it is that nothing of it shows up.
      if (!plugin.enabled) continue;

      for (const placement of app.ui?.placements ?? []) {
        // A surface id that does not resolve means the manifest reached the
        // registry without this check (an older install, a hand-edited
        // registry). The entry would open nothing, so it is dropped rather
        // than shown broken.
        const surface = placement.surface === undefined
          ? undefined
          : app.ui?.surfaces?.find((candidate) => candidate.id === placement.surface);
        if (placement.surface !== undefined && !surface) continue;
        placements.push({
          pluginId: plugin.id,
          pluginName: plugin.name,
          appId: app.appId,
          slot: placement.slot,
          scope: placement.scope,
          ...(surface ? { surfaceId: surface.id, server: surface.server } : {}),
          availability: surface?.availability ?? (app.runtime === 'standalone' ? 'always' : 'session'),
          title: surface?.title ?? { en: app.appId, zh: app.appId },
          icon: surface?.icon ?? 'plug',
        });
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
  placements.sort(comparePlacement);

  return { surfaces, conflicts, placements };
}

function comparePlacement(left: PluginUiPlacementDirectoryEntry, right: PluginUiPlacementDirectoryEntry): number {
  return SLOT_ORDER.indexOf(left.slot) - SLOT_ORDER.indexOf(right.slot)
    || left.pluginId.localeCompare(right.pluginId)
    || left.appId.localeCompare(right.appId)
    || (left.surfaceId ?? '').localeCompare(right.surfaceId ?? '');
}

function compareOwner(
  left: { pluginId: string; pluginName: string; appId: string },
  right: { pluginId: string; pluginName: string; appId: string },
): number {
  return left.pluginId.localeCompare(right.pluginId) || left.appId.localeCompare(right.appId);
}
