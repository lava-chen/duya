/** Public plugin management DTOs contain no manifest, credentials or install paths. */
export interface HostManagedPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly marketplace: string;
  readonly source: string;
  readonly capabilities: readonly string[];
  readonly description: string;
  readonly permissions: readonly string[];
}

export interface HostPluginInstallInput {
  readonly pluginId?: string | undefined;
  readonly fromPath?: string | undefined;
  readonly marketplace?: string | undefined;
  readonly scope?: string | undefined;
}

export interface HostPluginManagementApiV1 {
  catalog(): Promise<{ plugins: readonly HostPluginCatalogItem[] }>;
  listMarketplaces(): Promise<{ marketplaces: readonly HostPluginMarketplace[] }>;
  addMarketplace(source: string): Promise<{ name: string }>;
  removeMarketplace(name: string): Promise<{ removed: boolean }>;
  refreshMarketplace(name: string): Promise<{ refreshed: boolean }>;
  list(): Promise<{ plugins: readonly HostManagedPlugin[] }>;
  info(id: string): Promise<HostManagedPlugin>;
  doctor(): Promise<{ checks: readonly { id: string; status: 'ok' | 'warn' | 'error'; message: string; pluginId?: string }[] }>;
  install(input: HostPluginInstallInput): Promise<{ plugin: HostManagedPlugin }>;
  setEnabled(id: string, enabled: boolean): Promise<{ plugin: HostManagedPlugin }>;
  uninstall(id: string, deleteData: boolean): Promise<{ id: string; removed: boolean }>;
  update(id: string): Promise<{ plugin: HostManagedPlugin }>;
}

export interface HostPluginCatalogItem {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly marketplace: string;
  readonly installed: boolean;
}

export interface HostPluginMarketplace {
  readonly name: string;
  readonly kind: 'git' | 'local';
  readonly hidden: boolean;
  readonly pluginCount: number;
  readonly error?: string | undefined;
}
