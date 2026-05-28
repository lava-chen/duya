import type {
  MergeOptions,
  PluginPriority,
  PluginSource,
  PrioritizedPlugin,
} from './types';
import type { PluginRegistryEntry } from '../types';
import { PRIORITY_ORDER } from './types';

export function mergePluginsByPriority(
  sources: PrioritizedPlugin[],
  options: MergeOptions = {},
): PrioritizedPlugin[] {
  const { managedLockedIds = new Set(), sessionPluginIds = new Set() } = options;

  const merged = new Map<string, PrioritizedPlugin>();

  for (const prioritized of sources) {
    const { entry, priority } = prioritized;
    const existing = merged.get(entry.id);

    if (existing) {
      const existingRank = PRIORITY_ORDER.indexOf(existing.priority);
      const newRank = PRIORITY_ORDER.indexOf(priority);

      if (newRank < existingRank) {
        if (managedLockedIds.has(existing.entry.id)) {
          continue;
        }
        merged.set(entry.id, prioritized);
      }
    } else {
      merged.set(entry.id, prioritized);
    }
  }

  return Array.from(merged.values());
}

export function buildPrioritizedList(
  sessionPlugins: Array<{ entry: PluginRegistryEntry; source: PluginSource }>,
  managedPlugins: Array<{ entry: PluginRegistryEntry; source: PluginSource }>,
  userPlugins: Array<{ entry: PluginRegistryEntry; source: PluginSource }>,
  projectPlugins: Array<{ entry: PluginRegistryEntry; source: PluginSource }>,
  builtinPlugins: Array<{ entry: PluginRegistryEntry; source: PluginSource }>,
  options: MergeOptions = {},
): PrioritizedPlugin[] {
  const allSources: PrioritizedPlugin[] = [
    ...sessionPlugins.map((p) => ({ ...p, priority: 'session' as PluginPriority })),
    ...managedPlugins.map((p) => ({ ...p, priority: 'managed' as PluginPriority })),
    ...userPlugins.map((p) => ({ ...p, priority: 'user' as PluginPriority })),
    ...projectPlugins.map((p) => ({ ...p, priority: 'project' as PluginPriority })),
    ...builtinPlugins.map((p) => ({ ...p, priority: 'builtin' as PluginPriority })),
  ];

  return mergePluginsByPriority(allSources, options);
}