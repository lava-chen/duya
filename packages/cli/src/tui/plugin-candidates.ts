/**
 * packages/cli/src/tui/plugin-candidates.ts
 *
 * Where `duya chat`'s `@` plugin candidates come from: the Host inventory.
 *
 * ## Why `@` offers plugins at all
 *
 * The desktop's `@` popover lists installed plugins (one row per plugin, the
 * apps they declare riding inside), and accepting one inserts `@<pluginId>`,
 * which the submit path rewrites into a structured `[@Name](plugin://id)`
 * mention. The CLI composer runs the same conversation model, so the same
 * affordance belongs here — `@` "point this turn at a plugin" is a composer
 * contract, not a desktop decoration. The rows come from the same Host read
 * `/plugin` uses (`GET /v1/local/plugins`), so the CLI's list and the
 * Desktop's list cannot disagree about which plugins exist.
 *
 * ## Stale-while-revalidate, because typing must never wait
 *
 * `context()` runs on EVERY keystroke with `@` open. It returns the cached
 * rows immediately and kicks a background refresh when the cache is past its
 * TTL, so the first `@` after startup may show nothing and the next
 * keystroke shows the plugins — the same shape the file walk's short cache
 * uses (`candidates.ts`), except the fetch is async so the caller also gets
 * `onUpdated` to repaint the open popup when the rows land.
 *
 * ## "This Host cannot say" is an empty list, once
 *
 * A Host without the inventory answers 404. That is a legitimate answer for
 * a candidate source: the popup offers no plugin rows, and the next refresh
 * attempt waits for the TTL — a client that hammered the route on every
 * keystroke would turn a missing capability into log noise. The error is
 * reported once through `onUpdated`'s optional error channel; the slash
 * commands are the surface that explains it to a human.
 */

import type { PluginMentionCapabilities, PopoverItem } from '@duya/input-completion';

/** How long a fetched list stays trusted. */
const PLUGIN_CACHE_TTL_MS = 5_000;

/** One plugin row, as the Host inventory reports it. */
interface PluginInventoryEntry {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly description?: string;
  readonly appConnections?: readonly string[];
  readonly mcpServers?: readonly string[];
  readonly skillNames?: readonly string[];
}

/** The slice of the Host client this source reads. Both reads are optional facts. */
interface MentionCapableClient {
  listPlugins?(): Promise<unknown>;
  listAppConnections?(): Promise<unknown>;
}

/** The cached answer one refresh produces. */
interface PluginCandidates {
  readonly rows: readonly PopoverItem[];
  readonly capabilities: readonly PluginMentionCapabilities[];
  readonly connectedProviders: readonly string[];
}

const EMPTY: PluginCandidates = { rows: [], capabilities: [], connectedProviders: [] };

/** The capability sentence a plugin's component summaries make. */
function capabilitySummary(entry: PluginInventoryEntry): string | undefined {
  const parts: string[] = [];
  const apps = entry.appConnections?.length ?? 0;
  const servers = entry.mcpServers?.length ?? 0;
  const skills = entry.skillNames?.length ?? 0;
  if (apps > 0) parts.push(`${apps} app${apps === 1 ? '' : 's'}`);
  if (servers > 0) parts.push(`${servers} MCP server${servers === 1 ? '' : 's'}`);
  if (skills > 0) parts.push(`${skills} skill${skills === 1 ? '' : 's'}`);
  return parts.length === 0 ? undefined : parts.join(' · ');
}

/** The string list one component field carries, read leniently. */
function readNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item !== '');
}

/**
 * Narrow one inventory record into what a candidate row needs.
 *
 * A plugin that does not say whether it is enabled counts as enabled: the
 * registry only writes `enabled = false` when the user turned it off — the
 * same default the Host's own projection applies.
 */
function narrowEntry(value: unknown): PluginInventoryEntry | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = typeof record['id'] === 'string' ? record['id'] : '';
  if (id === '') return undefined;
  const description = record['description'];
  return {
    id,
    name: typeof record['name'] === 'string' && record['name'] !== '' ? record['name'] : id,
    enabled: record['enabled'] !== false,
    description: typeof description === 'string' && description !== '' ? description : undefined,
    appConnections: readNames(record['appConnections']),
    mcpServers: readNames(record['mcpServers']),
    skillNames: readNames(record['skillNames']),
  };
}

/** The plugins in an inventory payload, enabled ones only. */
function readPlugins(payload: unknown): readonly PluginInventoryEntry[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const raw = (payload as { readonly plugins?: unknown }).plugins;
  if (!Array.isArray(raw)) return [];
  return raw.map(narrowEntry).filter((entry): entry is PluginInventoryEntry => entry !== undefined)
    .filter((entry) => entry.enabled);
}

/** The connected providers in an app-connection payload. */
function readConnectedProviders(payload: unknown): readonly string[] {
  if (!Array.isArray(payload)) return [];
  const providers: string[] = [];
  for (const item of payload) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (record['status'] !== 'connected') continue;
    const provider = record['provider'];
    if (typeof provider === 'string' && provider !== '' && !providers.includes(provider)) {
      providers.push(provider);
    }
  }
  return providers;
}

export interface PluginCompletionSource {
  /** The cached `@` rows. Returns immediately; refreshes in the background. */
  list(): readonly PopoverItem[];
  /** The mention summaries for the same plugins, for the submit rewrite. */
  capabilities(): readonly PluginMentionCapabilities[];
  /** Providers with a live connection, for the mention's app activation. */
  connectedProviders(): readonly string[];
  /** Re-read the inventory now; resolves when the cache is rebuilt. */
  refresh(): Promise<void>;
  /** True once at least one refresh answered (even with an empty list). */
  hasAnswered(): boolean;
}

/**
 * A cached `@` plugin source over the Host inventory.
 *
 * `onUpdated` fires after every refresh that CHANGED the rows — a composer
 * uses it to repaint an open popup. Errors surface the same way, once per
 * failed refresh, rather than being thrown: a missing capability must not
 * break typing.
 */
export function createPluginCompletionSource(
  client: MentionCapableClient,
  options: {
    readonly ttlMs?: number;
    readonly now?: () => number;
    readonly onUpdated?: () => void;
  } = {},
): PluginCompletionSource {
  const ttlMs = options.ttlMs ?? PLUGIN_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  let cached: PluginCandidates = EMPTY;
  let fetchedAt = Number.NEGATIVE_INFINITY;
  let answered = false;
  let inFlight: Promise<void> | null = null;

  const rebuild = async (): Promise<void> => {
    if (typeof client.listPlugins !== 'function') {
      cached = EMPTY;
      answered = true;
      return;
    }
    const [plugins, connections] = await Promise.all([
      client.listPlugins!(),
      typeof client.listAppConnections === 'function'
        ? client.listAppConnections().catch(() => [])
        : Promise.resolve([]),
    ]);
    const entries = readPlugins(plugins);
    const connected = readConnectedProviders(connections);
    const capabilities: PluginMentionCapabilities[] = entries.map((entry) => ({
      pluginId: entry.id,
      name: entry.name,
      description: entry.description,
      appConnections: [...(entry.appConnections ?? [])],
      mcpServers: [...(entry.mcpServers ?? [])],
      skillNames: [...(entry.skillNames ?? [])],
    }));
    const rows: PopoverItem[] = entries.map((entry) => {
      const summary = capabilitySummary(entry);
      return {
        label: entry.name,
        value: entry.id,
        description: summary !== undefined && entry.description !== undefined
          ? `${summary} — ${entry.description}`
          : entry.description ?? summary,
        group: 'apps' as const,
        category: 'context' as const,
      };
    });
    const next: PluginCandidates = { rows, capabilities, connectedProviders: [...connected] };
    const changed = JSON.stringify(next) !== JSON.stringify(cached);
    cached = next;
    answered = true;
    if (changed) options.onUpdated?.();
  };

  return {
    list(): readonly PopoverItem[] {
      if (now() - fetchedAt >= ttlMs && inFlight === null) {
        inFlight = rebuild()
          .catch(() => undefined)
          .finally(() => {
            fetchedAt = now();
            inFlight = null;
          });
      }
      return cached.rows;
    },
    capabilities(): readonly PluginMentionCapabilities[] {
      return cached.capabilities;
    },
    connectedProviders(): readonly string[] {
      return cached.connectedProviders;
    },
    async refresh(): Promise<void> {
      if (inFlight !== null) return inFlight;
      inFlight = rebuild()
        .catch(() => undefined)
        .finally(() => {
          fetchedAt = now();
          inFlight = null;
        });
      return inFlight;
    },
    hasAnswered(): boolean {
      return answered;
    },
  };
}
