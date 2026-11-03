/**
 * The plugin management contract a client writes through.
 *
 * ## Why this is separate from the inventory
 *
 * `plugin-inventory.ts` answers "what does this Host have". This answers "what
 * could it have, and change it" — the marketplace catalog plus the install,
 * enable and marketplace mutations. It stays a separate contract because the
 * read-only surface is safe to serve anywhere, while a write surface is only
 * ever composed into a local Host that a person is sitting in front of.
 *
 * ## What a client may NOT infer
 *
 * Nothing here carries a path. An install resolves its own source directory on
 * the Host, and a client that learned the path could not use it: the layout is
 * the Host's to change. A mutation returns the row it produced plus the revision
 * the file now has, which is enough for a surface to refresh its list.
 *
 * ## Revision
 *
 * `expectedRevision` is optional everywhere. Echoing the revision read with the
 * row turns "someone edited this in the Desktop while my panel was open" into a
 * refusal; omitting it is the caller choosing to write blind.
 */

/** How much the Host trusts a catalog row, inherited from its marketplace. */
export type HostPluginTrustLevel = 'official' | 'verified' | 'community';

/** Whether the marketplace lets this plugin be installed at all. */
export type HostPluginInstallPolicy = 'available' | 'not_available' | 'installed_by_default';

/** When the plugin expects its credentials. */
export type HostPluginAuthPolicy = 'on_install' | 'on_use';

/** One plugin a configured marketplace offers. */
export interface HostPluginCatalogEntry {
  readonly pluginId: string;
  readonly marketplace: string;
  /** The manifest name — an identifier, not the label to render. */
  readonly name: string;
  /** The manifest's `interface.displayName`, the label a user recognizes. */
  readonly displayName?: string;
  readonly shortDescription?: string;
  readonly longDescription?: string;
  /** The manifest's top-level description, used when `interface` is absent. */
  readonly description?: string;
  readonly version: string;
  readonly category?: string;
  readonly trustLevel: HostPluginTrustLevel;
  readonly installPolicy: HostPluginInstallPolicy;
  readonly authPolicy?: HostPluginAuthPolicy;
  /** True when `config.toml` records this plugin for this marketplace. */
  readonly installed: boolean;
  /** The recorded user intent, false when not installed. */
  readonly enabled: boolean;
  /**
   * True when the package is not inside the marketplace clone and has to be
   * fetched from its own repository at install time.
   */
  readonly requiresClone: boolean;
}

/** A marketplace that contributed neither entries nor a count, and why. */
export interface HostMarketplaceIssue {
  readonly marketplace: string;
  readonly error: string;
}

/** The installable list, as of this read. */
export interface HostPluginCatalogList {
  readonly entries: readonly HostPluginCatalogEntry[];
  readonly marketplaces: readonly string[];
  /** A broken source is reported here rather than silently shrinking the list. */
  readonly issues: readonly HostMarketplaceIssue[];
  readonly revision: string;
  /**
   * Set when `config.toml` itself could not be read.
   *
   * An empty list means "nothing is offered"; this field is what distinguishes
   * it from "the configuration is malformed, so nothing could be determined" —
   * and the only place a surface can tell the user which file to fix.
   */
  readonly error?: string;
}

/** One configured marketplace and what the Host can see of it. */
export interface HostMarketplaceView {
  /** The `[marketplaces.<name>]` key. */
  readonly name: string;
  /** The label to render — the manifest's, then the configured one, then `name`. */
  readonly displayName: string;
  readonly kind: 'git' | 'local';
  readonly url?: string;
  readonly path?: string;
  readonly ref?: string;
  readonly hidden: boolean;
  readonly addedAt?: string;
  /** Set when the clone is missing or its catalog could not be read. */
  readonly error?: string;
  readonly pluginCount: number;
  /** True for a source a launch would re-seed; removal writes a tombstone. */
  readonly isDefault: boolean;
}

export interface HostMarketplaceList {
  readonly marketplaces: readonly HostMarketplaceView[];
  readonly revision: string;
  /** As in {@link HostPluginCatalogList.error} — the file, not a source, is broken. */
  readonly error?: string;
}

export interface HostPluginInstallInput {
  readonly pluginId: string;
  /** Omit to take the first marketplace that offers the id. */
  readonly marketplace?: string;
  /** Default true: installing a plugin and leaving it off is two steps nobody means. */
  readonly enabled?: boolean;
  readonly expectedRevision?: string;
}

export interface HostPluginEnabledInput {
  readonly pluginId: string;
  readonly marketplace?: string;
  readonly enabled: boolean;
  readonly expectedRevision?: string;
}

export interface HostPluginRemoveInput {
  readonly pluginId: string;
  readonly marketplace?: string;
  /** Also delete the plugin's own data directory. */
  readonly deleteData?: boolean;
  readonly expectedRevision?: string;
}

/** A marketplace source string as a person types it: git URL, `owner/repo`, or a directory. */
export interface HostMarketplaceAddInput {
  readonly source: string;
  readonly ref?: string;
  readonly expectedRevision?: string;
}

export interface HostMarketplaceRemoveInput {
  readonly marketplace: string;
  readonly expectedRevision?: string;
}

/** The plugin row a mutation produced, with the revision to echo back. */
export interface HostPluginMutationResult {
  readonly pluginId: string;
  readonly marketplace: string;
  readonly enabled: boolean;
  /** Observed on disk, not assumed: an enable of a missing package says so. */
  readonly installed: boolean;
  readonly version?: string;
  readonly revision: string;
}

export interface HostPluginRemoveResult {
  readonly pluginId: string;
  readonly marketplace: string;
  /** Paths the Host deleted, so a client can say what left the machine. */
  readonly removedPaths: readonly string[];
  readonly revision: string;
}

export interface HostMarketplaceMutationResult {
  readonly marketplace: HostMarketplaceView;
  readonly revision: string;
}

/** One marketplace's sync result; an error there does not fail the call. */
export interface HostMarketplaceSyncOutcome {
  readonly marketplace: string;
  readonly error?: string;
}

export interface HostMarketplaceRefreshResult {
  readonly outcomes: readonly HostMarketplaceSyncOutcome[];
  readonly revision: string;
}

/**
 * Local-only marketplace catalog reads and plugin/marketplace mutations.
 *
 * Optional on the HTTP server: a Host composed without the plugin install root
 * answers 404 with a named code rather than reporting an empty catalog, so
 * "no plugins are offered" and "this Host cannot manage plugins" never read
 * the same.
 */
export interface HostLocalPluginManagementApiV1 {
  listPluginCatalog(): Promise<HostPluginCatalogList>;
  listMarketplaces(): Promise<HostMarketplaceList>;
  installPlugin(input: HostPluginInstallInput): Promise<HostPluginMutationResult>;
  setPluginEnabled(input: HostPluginEnabledInput): Promise<HostPluginMutationResult>;
  removePlugin(input: HostPluginRemoveInput): Promise<HostPluginRemoveResult>;
  addMarketplace(input: HostMarketplaceAddInput): Promise<HostMarketplaceMutationResult>;
  removeMarketplace(input: HostMarketplaceRemoveInput): Promise<HostMarketplaceMutationResult>;
  /** Omit `marketplace` to sync every configured source, one outcome each. */
  refreshMarketplace(input: {
    readonly marketplace?: string;
    readonly expectedRevision?: string;
  }): Promise<HostMarketplaceRefreshResult>;
}
