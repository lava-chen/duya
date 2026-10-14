import type { AppConnectionToolExecutor, ConnectorReplaceSetPort } from '../../src/AppConnectionTool/ports.js';

type RegistryEntry = Parameters<ConnectorReplaceSetPort<AppConnectionToolExecutor>['replaceByOwner']>[1][number];

/** Small owner-aware test double for the capability's registry projection. */
export class ConnectorRegistryStub implements ConnectorReplaceSetPort<AppConnectionToolExecutor> {
  readonly #entries = new Map<string, { owner: `connector:${string}`; entry: RegistryEntry }>();

  get size(): number { return this.#entries.size; }
  has(key: string): boolean { return this.#entries.has(key); }
  getOwner(key: string): string | undefined { return this.#entries.get(key)?.owner; }
  getMeta(key: string): RegistryEntry['meta'] | undefined { return this.#entries.get(key)?.entry.meta; }

  replaceByOwner(owner: `connector:${string}`, preparedEntries: ReadonlyArray<RegistryEntry>) {
    const previousKeys = [...this.#entries]
      .filter(([, value]) => value.owner === owner)
      .map(([key]) => key);
    const preparedKeys = new Set(preparedEntries.map((entry) => entry.key));
    for (const entry of preparedEntries) {
      const current = this.#entries.get(entry.key);
      if (current && current.owner !== owner) throw new Error(`key collision: ${entry.key}`);
    }
    const removedKeys = previousKeys.filter((key) => !preparedKeys.has(key));
    const addedKeys = preparedEntries.filter((entry) => !this.#entries.has(entry.key)).map((entry) => entry.key);
    const keptKeys = previousKeys.filter((key) => preparedKeys.has(key));
    for (const key of previousKeys) this.#entries.delete(key);
    for (const entry of preparedEntries) this.#entries.set(entry.key, { owner, entry });
    return { removedKeys, addedKeys, keptKeys };
  }
}
