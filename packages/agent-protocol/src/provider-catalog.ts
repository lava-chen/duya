/**
 * The provider catalog: every configured provider and the models it serves.
 *
 * ## Why this is a contract and not a table
 *
 * `provider_model_capabilities` is an OVERRIDE table. It is written by the
 * Desktop provider editor and by the models API, and it is empty on a machine
 * whose providers came from `~/.duya/config.toml` — the CLI's own provider
 * store never wrote a row there. A reader that treats that table as "the
 * models of this provider" therefore reports an empty list on exactly the
 * machines that have the most models configured, which is what made the TUI's
 * `/model` picker look broken.
 *
 * The catalog closes that gap: it is derived from the configuration that
 * actually decides which provider answers a request (`[providers.*]` in
 * `config.toml`), enriched with the built-in model directory for the facts a
 * configuration file cannot carry — context window, reasoning support and the
 * thinking tiers a model accepts.
 *
 * Type-only on purpose: this package has zero runtime dependencies, so the
 * catalog is data, never a reader.
 */

/** One model a provider serves, with what is known about it. */
export interface HostProviderCatalogModel {
  readonly modelId: string;
  /** Human name from the built-in model directory, when it has one. */
  readonly displayName?: string;
  /** Total context window in tokens. */
  readonly contextWindow?: number;
  /** Maximum output tokens. */
  readonly maxOutputTokens?: number;
  /** True when the model can reason (thinking). */
  readonly supportsReasoning?: boolean;
  /** True when the model accepts image input. */
  readonly supportsVision?: boolean;
  /**
   * Thinking tiers this model accepts, e.g. `['low', 'medium', 'high', 'max']`.
   *
   * `auto` is NOT included: it means "no explicit tier", which every model
   * supports regardless of its ladder.
   */
  readonly reasoningEffortOptions?: readonly string[];
  /** True when this is the provider's configured default model. */
  readonly isProviderDefault?: boolean;
}

/** One configured provider and the models it serves. */
export interface HostProviderCatalogProvider {
  readonly providerId: string;
  readonly name: string;
  /** Raw `providerType` from the configuration (`anthropic`, `openrouter`, ...). */
  readonly providerType: string;
  readonly baseUrl?: string;
  /** False when the provider has no API key — it cannot serve a turn. */
  readonly hasApiKey: boolean;
  /** The provider's default model, when it declares one. */
  readonly defaultModel?: string;
  readonly models: readonly HostProviderCatalogModel[];
  /**
   * The built-in presets this vendor is known for, minus the ones already in
   * `models`.
   *
   * `enabled_models` is a hand-written list, so a configured provider normally
   * names one or two models while its vendor has a dozen. A picker that reads
   * only `models` therefore cannot reach any of them without an edit to
   * `config.toml`. These rows are the answer to "which models could this
   * provider serve", and they are kept separate because they are NOT
   * configured: selecting one makes the run resolve a model the configuration
   * does not list, which `resolveModel` accepts with a warning rather than a
   * refusal, and rewriting `config.toml` from the Host is not something this
   * codebase does.
   */
  readonly presetModels?: readonly HostProviderCatalogModel[];
}

/** The whole catalog, plus where it was read from. */
export interface HostProviderCatalog {
  readonly providers: readonly HostProviderCatalogProvider[];
  /** Provider selected by the configuration's `[model].provider`. */
  readonly activeProviderId?: string;
  /** Model selected by the configuration's `[model].default`. */
  readonly activeModel?: string;
  /** Directory the configuration was read from. */
  readonly configRoot: string;
  /**
   * Why the catalog is empty, when it is.
   *
   * A missing or malformed configuration is a reportable state, not an empty
   * list: the caller has to tell the user WHICH file to fix.
   */
  readonly error?: string;
}

/** Local-only access to the configured provider catalog. */
export interface HostLocalProviderCatalogApiV1 {
  getProviderCatalog(): Promise<HostProviderCatalog>;
}
