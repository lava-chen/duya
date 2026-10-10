/**
 * File-backed CLI configuration (`~/.duya/config.toml` + `secrets.json`).
 *
 * Why this module exists: the CLI used to resolve its provider from an
 * `api_providers` row in its own private `%APPDATA%/DUYA/duya.db`. Nothing in
 * the desktop app ever wrote that table — the desktop deliberately dropped it
 * (migration `drop_api_providers_table` in
 * `apps/desktop/src/main/db/schema.ts`) and moved providers to the unified
 * config store. The result was a silent empty result: the reader succeeded,
 * returned zero rows, and the CLI reported the generic "API key is required"
 * even when the user had a complete, working provider configured. The
 * settings helpers in `db-config.ts` failed the same way, each falling
 * through to a hard-coded default (see `readCliSettings`).
 *
 * Conventions followed rather than invented:
 * - `resolveConfigRoot()` from `hooks/config.ts` (`~/.duya`, or
 *   `~/.duya/test-namespaces/<ns>` under `DUYA_TEST=1` + `DUYA_TEST_NAMESPACE`),
 *   with the same injectable-root seam `readToolExposureConfig` /
 *   `readDecisionsConfig` use so tests can point at a temp dir.
 * - `secrets.json` holds FLAT DOTTED keys (`providers.minimax-cn.apiKey`),
 *   not nested objects. See `mcp/config.ts` `mergeMcpSecrets` and
 *   `getSecret` in `packages/cli/src/commands/doctor-config.ts`. Reading
 *   `secrets.providers[id].apiKey` silently returns undefined.
 *
 * READ-ONLY BY DESIGN. `permissions/policy.ts` hard-denies writes to
 * `config.toml` and `secrets.json` even in bypass mode, because a past
 * hand-edit made the file unparseable and silently wiped every provider.
 * Nothing here writes either file.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from '@iarna/toml';
import { resolveConfigRoot } from '../../hooks/config.js';

/** Wire protocol the agent speaks. Mirrors the `-p/--provider` flag vocabulary. */
export type CliProtocol = 'anthropic' | 'openai';

/**
 * Why a particular model was chosen. Surfaced to the user because the
 * resolution can legitimately land on something the user did not name: the
 * stored `model.default` is often absent from the active provider's
 * `enabled_models`, and sending it anyway would fail at the provider.
 */
export type ModelSource =
  | 'flag'              // explicit --model
  | 'provider-default'  // providers.<id>.options.defaultModel
  | 'enabled-models'    // providers.<id>.options.enabled_models[0]
  | 'config-default';   // [model].default (last resort)

export interface ResolvedModel {
  model: string;
  source: ModelSource;
  /**
   * Set when the chosen model is not served by the provider
   * (`options.enabled_models`). The caller should surface this instead of
   * silently sending a model the provider will reject.
   */
  warning?: string;
}

export interface ResolvedProvider {
  id: string;
  name: string;
  /** Raw `providerType` as written in config.toml. */
  providerType: string;
  /** `providerType` mapped onto the CLI's flag vocabulary. */
  protocol: CliProtocol;
  baseUrl: string;
  apiKey: string;
  /** Deterministic model pick; `model` is always set when this resolves. */
  model: ResolvedModel;
}

export interface CliSettings {
  /**
   * `agent.max_turns` from config.toml. `undefined` means "no cap set" —
   * deliberately NOT 0, so callers cannot confuse "uncapped" with "read a
   * default from a dead store".
   */
  maxTurns?: number;
  /**
   * `[mcp_servers.*]` names from config.toml. The CLI only needs the names:
   * `mcp/config.ts` `readUserMcpToml()` already loads the full definitions
   * (and merges secrets), so duplicating that reader here would create a
   * second source of truth for server definitions.
   */
  mcpServerNames: string[];
}

/**
 * Why provider resolution failed. Each case names a DIFFERENT real problem;
 * the whole point of the fix is that these no longer collapse into one
 * generic "API key is required".
 */
export type ProviderFailureReason =
  | 'config-missing'       // no config.toml at the resolved root
  | 'config-unreadable'    // present but not readable (permissions, IO)
  | 'config-malformed'     // present but not parseable as TOML
  | 'no-provider-selected' // [model].provider absent/empty
  | 'provider-unknown'     // [model].provider names a missing provider
  | 'secrets-missing'      // no secrets.json
  | 'secrets-malformed'    // secrets.json unreadable or not an object
  | 'api-key-missing'      // provider exists, key absent in secrets.json
  | 'model-unresolved'     // no --model, no defaultModel, no enabled_models, no [model].default

export type ProviderResolution =
  | { ok: true; provider: ResolvedProvider; configRoot: string }
  | { ok: false; reason: ProviderFailureReason; message: string; configRoot: string };

// ---------------------------------------------------------------------------
// providerType -> protocol
// ---------------------------------------------------------------------------

/**
 * Map a config.toml `providerType` onto the CLI's `-p/--provider`
 * vocabulary. The raw string must never be passed through: `openai-compatible`
 * and `openrouter` are both OpenAI-shaped on the wire, and neither is a valid
 * value for the flag. Mirrors the classification `inferProvider` in
 * `@duya/ai` performs for the same three values.
 */
export function mapProviderType(providerType: string | undefined): CliProtocol | undefined {
  switch ((providerType ?? '').trim().toLowerCase()) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
    case 'openai-compatible':
    case 'openrouter':
      return 'openai';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// secrets.json (flat dotted keys)
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Resolve a dotted key in secrets.json. The flat form
 * (`"providers.minimax-cn.apiKey"`) is the on-disk shape and is checked
 * FIRST; the nested walk is a fallback for hand-written files. Returning
 * the flat form first mirrors `getSecret` in
 * `packages/cli/src/commands/doctor-config.ts`.
 */
export function getSecret(secrets: Record<string, unknown> | null, dotted: string): string | undefined {
  if (!secrets) return undefined;
  if (Object.prototype.hasOwnProperty.call(secrets, dotted)) {
    const v = secrets[dotted];
    return typeof v === 'string' ? v : undefined;
  }
  let cur: unknown = secrets;
  for (const part of dotted.split('.')) {
    if (!isPlainObject(cur)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = cur[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

function loadSecrets(root: string): { doc: Record<string, unknown> | null; problem?: ProviderFailureReason; detail?: string } {
  const secretsPath = path.join(root, 'secrets.json');
  if (!fs.existsSync(secretsPath)) return { doc: null, problem: 'secrets-missing' };
  let raw: string;
  try {
    raw = fs.readFileSync(secretsPath, 'utf-8');
  } catch (err) {
    return {
      doc: null,
      problem: 'secrets-missing',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { doc: null, problem: 'secrets-malformed', detail: err instanceof Error ? err.message : String(err) };
  }
  if (!isPlainObject(parsed)) {
    return { doc: null, problem: 'secrets-malformed', detail: 'secrets.json root is not an object' };
  }
  return { doc: parsed };
}

// ---------------------------------------------------------------------------
// model resolution
// ---------------------------------------------------------------------------

/**
 * Pick the model deterministically, following the order used elsewhere in
 * the repo (`memory-model-resolution.ts` resolveMemoryModel: defaultModel ->
 * model -> enabled_models[0] -> protocol default), with the explicit --model
 * flag hoisted to the front and `[model].default` as the documented last
 * resort.
 *
 * The pick is then checked against `enabled_models` and a warning attached
 * when it is not served. That check is deliberately applied to the CHOSEN
 * value rather than only to the `config-default` branch: an earlier version
 * warned only for `config-default`, but that branch is only reachable when
 * `enabled_models` is absent, so the guard could never fire. A user who
 * passes `--model claude-sonnet-4` to a MiniMax provider hits exactly the
 * same provider-side failure and deserves the same warning.
 */
export function resolveModel(
  explicitModel: string | undefined,
  providerOptions: Record<string, unknown> | undefined,
  configDefault: string | undefined,
): ResolvedModel {
  const opts = providerOptions ?? {};
  const enabledModels = Array.isArray(opts.enabled_models)
    ? opts.enabled_models.filter((m): m is string => typeof m === 'string' && m.length > 0)
    : [];

  const fromEnabled = enabledModels[0];
  const candidates: Array<[ModelSource, string | undefined]> = [
    ['flag', explicitModel],
    ['provider-default', typeof opts.defaultModel === 'string' ? opts.defaultModel : undefined],
    ['enabled-models', fromEnabled],
    ['config-default', configDefault],
  ];

  const chosen = candidates.find((entry): entry is [ModelSource, string] => !!entry[1]);
  if (!chosen) return { model: '', source: 'config-default' };

  const [source, model] = chosen;
  if (enabledModels.length > 0 && !enabledModels.includes(model)) {
    return {
      model,
      source,
      warning:
        `model "${model}" (chosen from ${source}) is not in this provider's enabled_models ` +
        `(${enabledModels.join(', ')}); the provider may reject it. Pass --model to override.`,
    };
  }
  return { model, source };
}

// ---------------------------------------------------------------------------
// provider resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the active provider from config.toml + secrets.json.
 *
 * `configRootOverride` mirrors `readToolExposureConfig` /
 * `readDecisionsConfig`: `resolveConfigRoot()` is fixed to `~/.duya`, so
 * tests pass their own root rather than mocking `os.homedir()`.
 */
export function resolveProvider(
  explicitModel?: string,
  configRootOverride?: string,
): ProviderResolution {
  const root = configRootOverride ?? resolveConfigRoot();
  const configPath = path.join(root, 'config.toml');

  if (!fs.existsSync(configPath)) {
    return {
      ok: false,
      reason: 'config-missing',
      message: `No provider configuration found at ${configPath}.`,
      configRoot: root,
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    return {
      ok: false,
      reason: 'config-unreadable',
      message: `Cannot read ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      configRoot: root,
    };
  }

  let doc: {
    model?: { provider?: unknown; default?: unknown; base_url?: unknown };
    providers?: Record<string, unknown>;
  };
  try {
    doc = parse(raw) as typeof doc;
  } catch (err) {
    return {
      ok: false,
      reason: 'config-malformed',
      message:
        `${configPath} is not valid TOML: ${err instanceof Error ? err.message : String(err)}. ` +
        'Fix the file by hand (the agent never rewrites it) or pass --api-key/--base-url.',
      configRoot: root,
    };
  }

  const providerId = typeof doc.model?.provider === 'string' ? doc.model.provider.trim() : '';
  if (!providerId) {
    return {
      ok: false,
      reason: 'no-provider-selected',
      message:
        `${configPath} has no [model].provider set, so no provider is selected. ` +
        'Set one in Settings, or pass --api-key/--base-url/--model.',
      configRoot: root,
    };
  }

  const providers = isPlainObject(doc.providers) ? doc.providers : {};
  const entry = providers[providerId];
  if (!isPlainObject(entry)) {
    const known = Object.keys(providers);
    return {
      ok: false,
      reason: 'provider-unknown',
      message:
        `[model].provider names "${providerId}", which is not defined under [providers] in ${configPath}. ` +
        (known.length > 0
          ? `Configured providers: ${known.join(', ')}.`
          : 'No providers are defined in that file.'),
      configRoot: root,
    };
  }

  const rawType = typeof entry.providerType === 'string' ? entry.providerType : undefined;
  const protocol = mapProviderType(rawType);
  if (!protocol) {
    return {
      ok: false,
      reason: 'provider-unknown',
      message:
        `Provider "${providerId}" has providerType ${JSON.stringify(rawType ?? null)}, ` +
        'which is not a supported provider type. Use anthropic, openai-compatible, or openrouter.',
      configRoot: root,
    };
  }

  const secrets = loadSecrets(root);
  if (secrets.problem) {
    const suffix = secrets.detail ? ` (${secrets.detail})` : '';
    return {
      ok: false,
      reason: secrets.problem,
      message:
        secrets.problem === 'secrets-missing'
          ? `No secrets.json at ${path.join(root, 'secrets.json')}${suffix}. Provider "${providerId}" is configured there, ` +
            'but its API key is stored in that file. Add the key, or pass --api-key.'
          : `Cannot read secrets.json at ${path.join(root, 'secrets.json')}${suffix}. ` +
            'Fix the JSON by hand (the agent never rewrites it), or pass --api-key.',
      configRoot: root,
    };
  }

  // FLAT dotted key: `providers.<id>.apiKey`. Not `secrets.providers[id].apiKey`.
  const apiKey = getSecret(secrets.doc, `providers.${providerId}.apiKey`);
  if (!apiKey) {
    return {
      ok: false,
      reason: 'api-key-missing',
      message:
        `Provider "${providerId}" has no API key: expected the flat key ` +
        `"providers.${providerId}.apiKey" in ${path.join(root, 'secrets.json')}. ` +
        'Add it there, or pass --api-key.',
      configRoot: root,
    };
  }

  const options = isPlainObject(entry.options) ? entry.options : undefined;
  const configDefault = typeof doc.model?.default === 'string' ? doc.model.default : undefined;
  const model = resolveModel(explicitModel, options, configDefault);
  if (!model.model) {
    return {
      ok: false,
      reason: 'model-unresolved',
      message:
        `No model could be resolved for provider "${providerId}": no --model, ` +
        'no options.defaultModel, no options.enabled_models, and no [model].default. ' +
        'Pass --model to choose one.',
      configRoot: root,
    };
  }

  const providerBaseUrl = typeof entry.baseUrl === 'string' ? entry.baseUrl.trim() : '';
  const configBaseUrl = typeof doc.model?.base_url === 'string' ? doc.model.base_url.trim() : '';

  return {
    ok: true,
    configRoot: root,
    provider: {
      id: providerId,
      name: typeof entry.name === 'string' && entry.name ? entry.name : providerId,
      providerType: rawType ?? protocol,
      protocol,
      baseUrl: providerBaseUrl || configBaseUrl,
      apiKey,
      model,
    },
  };
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

/**
 * Read the CLI-relevant settings from config.toml.
 *
 * These previously came from the same retired `duya.db`, where every lookup
 * missed and silently fell through to a hard-coded default — `max_turns` read
 * as '0' (uncapped) and `mcp_servers` as [] even when the user had set both.
 * Only the settings that actually have a config.toml home are read here;
 * `agent_mode`, `permission_profile`, `tool_display_mode` and
 * `skillAdditionalPaths` have no config.toml equivalent and are reported as
 * such in the PR body rather than being invented here.
 *
 * NOT cached: an edit to config.toml applies on the next CLI run, matching
 * the hot-reload semantics of `readSteeringConfig`.
 */
export function readCliSettings(configRootOverride?: string): CliSettings {
  const settings: CliSettings = { mcpServerNames: [] };
  const configPath = path.join(configRootOverride ?? resolveConfigRoot(), 'config.toml');
  let doc: { agent?: { max_turns?: unknown }; mcp_servers?: unknown };
  try {
    if (fs.existsSync(configPath)) {
      doc = parse(fs.readFileSync(configPath, 'utf-8')) as typeof doc;
      const maxTurns = doc.agent?.max_turns;
      if (typeof maxTurns === 'number' && Number.isFinite(maxTurns) && maxTurns > 0) {
        settings.maxTurns = Math.floor(maxTurns);
      }
      if (isPlainObject(doc.mcp_servers)) {
        settings.mcpServerNames = Object.keys(doc.mcp_servers);
      }
    }
  } catch {
    // Settings are optional; a malformed config.toml is already reported by
    // resolveProvider with a message naming the file and the parse error.
  }
  return settings;
}