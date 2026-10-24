/**
 * agent-config-schema.ts — the `[agents.<id>]` config shape.
 *
 * One definition for the whole product: the Desktop config store, the
 * standalone Host and the worker all read and write the same TOML tables, so
 * a field that only one of them knows about is a field the other two drop.
 *
 * The optional fields are declared as `?: T | undefined` on purpose: the
 * upsert merge sets an absent field to an explicit `undefined` (the field is
 * present in the object, absent in the TOML output), and `exactOptionalProperty-
 * Types` would reject that otherwise.
 *
 * The soft-delete fields (`deleted_at` / `deleted_reason` / `deleted_purge_at`)
 * live on the same entry: a live agent keeps them null, a soft-deleted agent
 * has them set and is filtered out of the live views.
 */

/** Tool allow/deny/profile for one agent. */
export interface CustomAgentToolsConfig {
  /** Base tool profile: 'full' | 'coding' | 'minimal' | 'research'. */
  profile?: string | undefined;
  /** Additional allowed tool patterns (wildcards supported, e.g. 'file:*'). */
  allow?: string[] | undefined;
  /** Denied tool patterns; deny wins. */
  deny?: string[] | undefined;
}

/** Structured prompt persona — overrides the registry fallback for prompt rendering. */
export interface CustomAgentPromptIdentityConfig {
  name?: string | undefined;
  description?: string | undefined;
  /** How the bot speaks (tone/style hint rendered by the botIdentity section). */
  voice?: string | undefined;
}

/** Section gating. Unknown section names are ignored (forward compatible). */
export interface CustomAgentPromptSectionsConfig {
  /** Whitelist: when non-empty, only these registered sections render. */
  enable?: string[] | undefined;
  /** Blacklist: these sections never render; wins over enable. */
  disable?: string[] | undefined;
}

/** `[agents.<id>.prompt]` table (bot system-prompt config). */
export interface CustomAgentPromptConfig {
  sections?: CustomAgentPromptSectionsConfig | undefined;
  identity?: CustomAgentPromptIdentityConfig | undefined;
}

/** One `[agents.<id>]` table. */
export interface CustomAgentConfig {
  /**
   * Display name (falls back to the map key).
   *
   * Declared without `| undefined` on purpose: the capability ports that
   * consume this type declare `name?: string`, and `exactOptionalProperty-
   * Types` treats the two as different shapes.
   */
  name?: string;
  /** One-line role description. */
  description?: string | undefined;
  /** Provider/model ref, e.g. 'anthropic/claude-sonnet-4-20250514'. */
  model?: string | undefined;
  /**
   * Provider store id the `model` belongs to (set by the bot settings UI).
   * Without it the model id is resolved against the default provider.
   */
  provider?: string | undefined;
  /**
   * This agent's own thinking level (bound to the model): 'off' disables
   * thinking, 'low'/'medium'/'high' map to the provider's native reasoning
   * effort. Absent → the runtime default ('medium').
   */
  reasoning?: 'off' | 'low' | 'medium' | 'high' | undefined;
  /** This agent's own working directory. Empty → default workspace. */
  workspace?: string | undefined;
  /** Path to this agent's global instruction file. Empty → <workspace>/AGENTS.md. */
  agents_md?: string | undefined;
  /** Tool allow/deny/profile. */
  tools?: CustomAgentToolsConfig | undefined;
  /** Plugin / mcp references enabled for this agent (e.g. 'mcp:github'). */
  plugins?: string[] | undefined;
  /** Bot system-prompt section config. Preserved as-is on upsert. */
  prompt?: CustomAgentPromptConfig | undefined;
  /**
   * Soft-delete timestamp in Unix ms. When set, the agent is in the
   * soft-deleted state — its tree lives under
   * `<agentsDir>/.deleted/<deletedAt>-<id>/` and it is filtered out of the
   * live views. `undefined` or `null` means "live".
   */
  deleted_at?: number | null | undefined;
  /** Optional free-text note from the caller (e.g. "owner request"). */
  deleted_reason?: string | null | undefined;
  /** Scheduled wall-clock time (Unix ms) when the bot is physically removed. */
  deleted_purge_at?: number | null | undefined;
}

/** Fields a config-agent upsert may set. */
export interface AgentUpsertInput {
  name: string;
  description?: string | undefined;
  /** Role subtitle — profile.json ONLY, never stored in config.toml. */
  title?: string | undefined;
  model?: string | undefined;
  /** Provider store id the `model` belongs to. Absent → preserve the existing value. */
  provider?: string | undefined;
  /** Thinking level bound to the model. Absent → preserve the existing value. */
  reasoning?: 'off' | 'low' | 'medium' | 'high' | undefined;
  workspace?: string | undefined;
  agents_md?: string | undefined;
  tools?: CustomAgentToolsConfig | undefined;
  plugins?: string[] | undefined;
  /** Color token for the initial-circle avatar, seeded into `profile.json` on first creation. */
  avatarColor?: string | undefined;
}

/** Fields an identity patch may change (name / description only). */
export interface AgentIdentityPatch {
  name?: string | undefined;
  description?: string | undefined;
}

/** Result of a create-semantics agent creation — `id` is the ACTUAL id. */
export interface CreatedConfigAgent {
  id: string;
  config: CustomAgentConfig;
}
