/**
 * provider-store-config.ts — `ProviderStoreReader` backed by `ConfigStore`.
 *
 * Replaces `ConfigManagerReader`. Reads providers from `config.providers`,
 * the soft default from `model.provider`, and the memory pointer from
 * `memory.provider` / `memory.model`. Because `ConfigStore` merges secrets
 * back into the snapshot on read, the returned `ApiProvider` objects carry
 * their `apiKey`.
 */

import type { ConfigStore } from '../../config/store';
import type { ProviderEntry } from '../../config/schema';
import type { ApiProvider } from '../../../src/lib/providers/types';
import type { ProviderStoreReader } from './provider-store';

export class ConfigStoreReader implements ProviderStoreReader {
  private store: ConfigStore;
  constructor(store: ConfigStore) {
    this.store = store;
  }

  readAll(): Record<string, ApiProvider> {
    const cfg = this.store.get();
    const out: Record<string, ApiProvider> = {};
    for (const [id, entry] of Object.entries(cfg.providers)) {
      out[id] = toApiProvider(id, entry);
    }
    return out;
  }

  readOne(id: string): ApiProvider | undefined {
    return this.readAll()[id];
  }

  readDefault(): ApiProvider | undefined {
    const id = this.store.getByPath('model.provider') as string;
    return id ? this.readOne(id) : undefined;
  }

  readMemory(): ApiProvider | undefined {
    const id = this.store.getByPath('memory.provider') as string;
    return id ? this.readOne(id) : this.readDefault();
  }

  writeMemory(id: string | null): boolean {
    this.store.set('memory.provider', id ?? '');
    return true;
  }

  readMemoryModel(): string | null {
    return (this.store.getByPath('memory.model') as string) || null;
  }

  writeMemoryModel(model: string | null): boolean {
    this.store.set('memory.model', model ?? '');
    return true;
  }

  writeAll(map: Record<string, ApiProvider>): boolean {
    const providers: Record<string, unknown> = {};
    for (const [id, p] of Object.entries(map)) {
      providers[id] = {
        id: p.id,
        name: p.name,
        providerType: p.providerType,
        baseUrl: p.baseUrl,
        options: p.options,
        enabled_models: (p as { enabled_models?: string[] }).enabled_models,
        apiKey: p.apiKey,
      };
    }
    this.store.set('providers', providers);
    return true;
  }

  onChange(cb: () => void): () => void {
    return this.store.subscribe(cb);
  }
}

function toApiProvider(id: string, entry: ProviderEntry): ApiProvider {
  const raw = entry as unknown as Record<string, unknown>;
  return {
    id,
    name: entry.name || id,
    providerType: entry.providerType as ApiProvider['providerType'],
    baseUrl: entry.baseUrl ?? '',
    options: entry.options,
    extraEnv: raw.extraEnv as ApiProvider['extraEnv'],
    headers: raw.headers as ApiProvider['headers'],
    notes: raw.notes as ApiProvider['notes'],
    sortOrder: raw.sortOrder as ApiProvider['sortOrder'],
    // apiKey is split to secrets.json but merged back into the snapshot
    // on read by `ConfigStore`, so it is present even though `ProviderEntry`
    // does not declare it.
    apiKey: (raw.apiKey as string) ?? '',
  };
}