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
 * Type-only on purpose, with one exception: this package has zero runtime
 * dependencies, so the catalog is data, never a reader. The single function
 * below is pure and dependency-free — it is here because it is the mask BOTH
 * surfaces must agree on, and no other package is importable from both the
 * renderer and the Host.
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

/**
 * ## The management surface: reading and writing the provider tables
 *
 * The catalog above answers "what can I pick"; this half answers "what is
 * configured, and change it". It exists because the only writer of
 * `[providers.*]` used to be the Electron main process, so a CLI user could
 * select a provider but never add one.
 *
 * The write is the same surgical namespace edit the config-agents surface uses,
 * and the key follows the Desktop contract: it lives in `secrets.json` as the
 * flat path `providers.<id>.apiKey`, never in `config.toml`. Consequently no
 * type below can carry a key — `apiKey` is write-only on the way in, and on
 * the way out there is only `hasApiKey` and a mask.
 *
 * `revision` is the pair of content hashes the Host computed when it answered.
 * A writer that omits `expectedRevision` over whatever it last read overwrites
 * blind; one that echoes it gets a refusal instead of losing the other
 * surface's edit. It is optional because the file has no version field to
 * enforce — this is a check, not a lock.
 */

/** One provider as the management surface shows it: editable fields, no key. */
export interface HostProviderDetail {
  readonly providerId: string;
  readonly name: string;
  /** Display nickname (`alias`), when the configuration carries one. */
  readonly alias?: string;
  readonly providerType: string;
  readonly baseUrl: string;
  /** `options.enabled_models` — the models this configuration lists. */
  readonly models: readonly string[];
  /** `options.defaultModel` — the model this provider picks when none is given. */
  readonly defaultModel?: string;
  readonly hasApiKey: boolean;
  /**
   * The stored key with its middle replaced (`sk-a***WXYZ`), or `''`.
   *
   * A row that cannot say which key is there is a row the user cannot tell
   * `stale production key` from `stale test key` apart; the mask is enough to
   * make that call and cannot be replayed against the vendor.
   */
  readonly maskedApiKey: string;
  /** True when `[model].provider` points at this provider. */
  readonly isDefault: boolean;
}

/** The whole provider table, as writable. */
export interface HostProviderList {
  readonly providers: readonly HostProviderDetail[];
  readonly activeProviderId?: string;
  readonly activeModel?: string;
  readonly configRoot: string;
  readonly revision: string;
  /** Why the list is empty, when the file could not be read. */
  readonly error?: string;
}

/**
 * Create or replace one provider.
 *
 * The declared fields are REPLACED — omitting `alias` clears it, because an
 * editor that submits a form has to be able to empty a field. Anything the
 * surface does not declare (an `options.model_context` table, `extraEnv`, a
 * hand-written key) is copied through untouched: a provider row is not the
 * writer's property.
 */
export interface HostProviderWriteInput {
  /** Existing id to edit, or omit to create one from `name`. */
  readonly providerId?: string;
  readonly name: string;
  readonly alias?: string;
  readonly providerType: string;
  readonly baseUrl?: string;
  readonly models?: readonly string[];
  readonly defaultModel?: string;
  /**
   * Write-only. Absent keeps the stored key, `''` clears it.
   *
   * A value that looks like a mask is refused rather than stored: saving the
   * mask back is how a client turns a working provider into a 401.
   */
  readonly apiKey?: string;
  readonly expectedRevision?: string;
}

/** The stored key with its middle hidden, in the shape every surface uses. */
export function maskProviderApiKey(key: string): string {
  if (key.length === 0) return '';
  return key.length > 8 ? `${key.slice(0, 4)}***${key.slice(-4)}` : '***';
}

/** One configured provider and what its endpoint said. */
export interface HostProviderTestResult {
  readonly ok: boolean;
  readonly code: HostProviderProbeCode;
  /** Never carries the key: the Host redacts before this crosses the wire. */
  readonly message?: string;
  readonly latencyMs: number;
  /**
   * Model ids the endpoint listed, capped by the Host.
   *
   * The same call answers "is this reachable" and "what does it serve",
   * because the only probe a key-having endpoint can be given is its own
   * model list. `truncated` says whether the tail was dropped.
   */
  readonly modelIds: readonly string[];
  readonly truncated: boolean;
}

/** Why a probe ended the way it did. */
export type HostProviderProbeCode =
  | 'ok'
  /** A provider that was configured without an endpoint cannot be dialed. */
  | 'no_base_url'
  /**
   * A key-authed endpoint with no key stored.
   *
   * Never used for a local runtime: Ollama and LM Studio answer unsigned, and
   * telling the user to fetch a key for them would be a false instruction.
   */
  | 'no_api_key'
  | 'auth'
  | 'not_found'
  | 'rate_limited'
  | 'rejected'
  | 'empty_list'
  | 'network'
  | 'timeout'
  /**
   * Nothing to dial: the vendor authenticates from the environment (a Bedrock
   * bearer token, Vertex application default credentials), so no key-bearing
   * model endpoint exists to ask.
   */
  | 'not_testable'
  | 'unknown';

/** Local-only read and write of the provider tables. */
export interface HostLocalProviderManagementApiV1 {
  listProviders(): Promise<HostProviderList>;
  upsertProvider(input: HostProviderWriteInput): Promise<HostProviderMutationResult>;
  deleteProvider(
    providerId: string,
    expectedRevision?: string,
  ): Promise<HostProviderDeleteResult>;
  setDefaultProvider(
    providerId: string | null,
    expectedRevision?: string,
  ): Promise<HostProviderDefaultResult>;
  /** Probe one stored provider: connectivity plus its remote model list. */
  testProvider(providerId: string): Promise<HostProviderTestResult>;
}

/** A provider row after a write, with the revision to echo back. */
export interface HostProviderMutationResult {
  readonly provider: HostProviderDetail;
  readonly revision: string;
}

/** What a delete removed, with the revision to echo back. */
export interface HostProviderDeleteResult {
  readonly providerId: string;
  /** True when the default pointer moved as a result (the deleted row was it). */
  readonly clearedDefault: boolean;
  readonly revision: string;
}

/** The default pointer after a write, with the revision to echo back. */
export interface HostProviderDefaultResult {
  readonly activeProviderId?: string;
  readonly activeModel?: string;
  readonly revision: string;
}
