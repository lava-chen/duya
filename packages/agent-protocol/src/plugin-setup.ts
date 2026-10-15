/** Local-only access to persisted plugin setup values for Desktop and Agent workers. */
export interface HostLocalPluginSetupApiV1 {
  listPluginSetupValues(): Promise<Record<string, Record<string, string>>>;
  /** Atomically merge supplied values without replacing stored secrets omitted by the caller. */
  mergePluginSetupValues(pluginId: string, values: Record<string, string>): Promise<void>;
  clearPluginSetupValues(pluginId: string): Promise<void>;
}
