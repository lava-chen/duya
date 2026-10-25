/**
 * The configured provider catalog, read from `~/.duya/config.toml`.
 *
 * ## Why the catalog is not the capability table
 *
 * `provider_model_capabilities` is an OVERRIDE table: the Desktop provider
 * editor and the models API write it, and nothing else does. On a machine
 * whose providers came from `config.toml` — which is every CLI-only install —
 * the table is empty, so "the models of this provider" read from it is empty
 * too. The TUI's `/model` picker used to read exactly that, which is why it
 * reported "no models registered" on a machine with five providers and dozens
 * of models configured.
 *
 * The catalog reads the configuration that actually decides which provider
 * answers a request (`[providers.*]`), which is the same file
 * `resolveProvider` (`file-config.ts`) resolves the worker from. One source of
 * truth, so the picker cannot offer a model the run will not use.
 *
 * ## What the configuration cannot say
 *
 * A configuration file names models; it does not say how large their context
 * is, whether they reason, or which thinking tiers they accept. Those come
 * from the built-in model directory (`@duya/ai`), and from
 * `options.model_context` when the user has spelled the window out (the
 * OpenRouter provider carries hundreds of entries that way).
 *
 * It also does not name the models the user has NOT written down, and a picker
 * built from `enabled_models` alone can therefore only ever offer the two or
 * three rows someone typed into a file. Each provider's vendor presets — the
 * curated `defaultModels` of the built-in catalog, which is exactly what the
 * Desktop's provider editor offers when adding a provider — travel as a
 * separate list (`presetModels`) so a client can show them as what they are.
 *
 * READ-ONLY, like every other reader in this directory: `config.toml` is
 * hand-edited and a bad write there wipes every provider. The one writer in
 * the Host is `../config-agents`, and it edits the `[agents]` namespace only
 * — it never rewrites the provider tables this catalog reads.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from '@iarna/toml';
import {
  allProviderModels,
  BUILTIN_CATALOG,
  getSupportedThinkingLevels,
  type Model,
  type ProviderCatalogEntry,
} from '@duya/ai';
import type {
  HostProviderCatalog,
  HostProviderCatalogModel,
  HostProviderCatalogProvider,
} from '@duya/agent-protocol/provider-catalog';
import { resolveConfigRoot } from '../agent-profile-config.js';
import { getSecret } from './file-config.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
}

/**
 * Find the built-in directory entry for a model.
 *
 * The provider id is checked first because the same model id can exist under
 * two providers with different ladders (`minimax/minimax-m3` on OpenRouter
 * and `MiniMax-M3` on MiniMax CN are different rows). A configured provider
 * whose id differs from the built-in one (`glm-cn` vs `glm`) still resolves by
 * model id alone, which is the common case for a renamed provider.
 */
function findBuiltinModel(providerId: string, modelId: string): Model | undefined {
  const byProvider = allProviderModels.find(
    (model) => model.providerId === providerId && model.id === modelId,
  );
  if (byProvider !== undefined) return byProvider;
  const byId = allProviderModels.filter((model) => model.id === modelId);
  // Prefer the entry that declares a thinking ladder: it is the one that
  // knows the effort tiers, and the first match may be a bare alias.
  return byId.find((model) => model.thinkingLevelMap !== undefined) ?? byId[0];
}

/** Thinking tiers a model accepts, without the implicit `auto`. */
function effortOptionsFor(model: Model | undefined): string[] | undefined {
  if (model === undefined || model.reasoning !== true) return undefined;
  const levels = getSupportedThinkingLevels(model)
    .filter((level) => level !== 'off')
    .map((level) => String(level));
  return levels.length > 0 ? levels : undefined;
}

interface ConfiguredProvider {
  readonly id: string;
  readonly name: string;
  readonly providerType: string;
  readonly baseUrl: string;
  readonly defaultModel: string | undefined;
  readonly enabledModels: readonly string[];
  readonly contextWindows: Readonly<Record<string, number>>;
}

function readConfiguredProviders(doc: Record<string, unknown>): ConfiguredProvider[] {
  const providers = isPlainObject(doc.providers) ? doc.providers : {};
  const out: ConfiguredProvider[] = [];
  for (const [key, raw] of Object.entries(providers)) {
    if (!isPlainObject(raw)) continue;
    const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : key;
    const options = isPlainObject(raw.options) ? raw.options : {};
    const modelContext = isPlainObject(options.model_context) ? options.model_context : {};
    const contextWindows: Record<string, number> = {};
    for (const [modelId, window] of Object.entries(modelContext)) {
      if (typeof window === 'number' && Number.isFinite(window) && window > 0) {
        contextWindows[modelId] = window;
      }
    }
    out.push({
      id,
      name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : id,
      providerType: typeof raw.providerType === 'string' ? raw.providerType : 'unknown',
      baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '',
      defaultModel:
        typeof options.defaultModel === 'string' && options.defaultModel.trim() !== ''
          ? options.defaultModel.trim()
          : undefined,
      enabledModels: readStringArray(options.enabled_models),
      contextWindows,
    });
  }
  return out;
}

function toCatalogModel(
  provider: ConfiguredProvider,
  modelId: string,
): HostProviderCatalogModel {
  const builtin = findBuiltinModel(provider.id, modelId);
  const configuredWindow = provider.contextWindows[modelId];
  const contextWindow = configuredWindow ?? builtin?.contextWindow;
  const effortOptions = effortOptionsFor(builtin);
  const supportsVision = builtin?.input?.includes('image') === true;
  const supportsReasoning = builtin?.reasoning === true;
  return {
    modelId,
    ...(builtin?.name !== undefined ? { displayName: builtin.name } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(builtin?.maxTokens !== undefined ? { maxOutputTokens: builtin.maxTokens } : {}),
    ...(supportsReasoning ? { supportsReasoning: true } : {}),
    ...(supportsVision ? { supportsVision: true } : {}),
    ...(effortOptions !== undefined ? { reasoningEffortOptions: effortOptions } : {}),
    ...(provider.defaultModel === modelId ? { isProviderDefault: true } : {}),
  };
}

/**
 * The built-in preset entry a configured provider's vendor corresponds to.
 *
 * A `config.toml` provider id and a catalog entry id are the same string for
 * every provider the Desktop wrote (`minimax-cn`, `glm-cn`, `openrouter`,
 * `lm-studio`), and differ only where the catalog splits one vendor across
 * endpoints (`anthropic` vs `anthropic-official`, `qwen` vs `qwen-openai`). So:
 * exact id first, then the FIRST entry whose id extends it. Taking the first
 * rather than every match is deliberate — `glm` resolves to `glm-cn` — because
 * the presets are a suggestion list, and a wrong suggestion is a row the user
 * can see and reject, while a merge of two regions' lists is a row that looks
 * right and bills differently.
 */
function findPresetEntry(providerId: string): ProviderCatalogEntry | undefined {
  const entries = BUILTIN_CATALOG.list().filter((entry) => entry.category !== 'media');
  const prefix = `${providerId}-`;
  return entries.find((entry) => entry.id === providerId)
    ?? entries.find((entry) => entry.id.startsWith(prefix));
}

/**
 * The preset models of a provider: what its vendor is known for, minus what
 * the configuration already lists.
 *
 * Empty when the vendor has no catalog entry — a custom `baseUrl` provider is
 * not the same thing as `openrouter`, and inventing a preset list for it would
 * put models on screen that its endpoint does not serve.
 */
function presetModelsFor(
  provider: ConfiguredProvider,
  configured: readonly string[],
): HostProviderCatalogModel[] {
  const entry = findPresetEntry(provider.id);
  if (entry === undefined) return [];
  const ids: string[] = [];
  for (const model of entry.defaultModels) {
    const modelId = model.modelId.trim();
    if (modelId === '' || configured.includes(modelId) || ids.includes(modelId)) continue;
    ids.push(modelId);
  }
  return ids.map((modelId) => toCatalogModel(provider, modelId));
}

/**
 * Read the whole catalog.
 *
 * Never throws: a missing or malformed configuration comes back as an empty
 * catalog with `error` set, because the caller's job is to tell the user
 * WHICH file to fix, not to crash the picker.
 */
export function readProviderCatalog(configRootOverride?: string): HostProviderCatalog {
  const root = configRootOverride ?? resolveConfigRoot();
  const configPath = path.join(root, 'config.toml');

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      providers: [],
      configRoot: root,
      error:
        code === 'ENOENT'
          ? `No provider configuration found at ${configPath}.`
          : `Cannot read ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let doc: Record<string, unknown>;
  try {
    doc = parse(raw) as Record<string, unknown>;
  } catch (error) {
    return {
      providers: [],
      configRoot: root,
      error:
        `${configPath} is not valid TOML: ${error instanceof Error ? error.message : String(error)}. ` +
        'Fix the file by hand (nothing here rewrites it).',
    };
  }

  const configured = readConfiguredProviders(doc);
  const secrets = readSecrets(root);
  const model = isPlainObject(doc.model) ? doc.model : {};

  const providers: HostProviderCatalogProvider[] = configured.map((provider) => {
    const modelIds = [...provider.enabledModels];
    if (provider.defaultModel !== undefined && !modelIds.includes(provider.defaultModel)) {
      modelIds.unshift(provider.defaultModel);
    }
    const presetModels = presetModelsFor(provider, modelIds);
    return {
      providerId: provider.id,
      name: provider.name,
      providerType: provider.providerType,
      ...(provider.baseUrl === '' ? {} : { baseUrl: provider.baseUrl }),
      hasApiKey: hasApiKey(secrets, provider.id),
      ...(provider.defaultModel !== undefined ? { defaultModel: provider.defaultModel } : {}),
      models: modelIds.map((modelId) => toCatalogModel(provider, modelId)),
      ...(presetModels.length === 0 ? {} : { presetModels }),
    };
  });

  return {
    providers,
    ...(typeof model.provider === 'string' && model.provider.trim() !== ''
      ? { activeProviderId: model.provider.trim() }
      : {}),
    ...(typeof model.default === 'string' && model.default.trim() !== ''
      ? { activeModel: model.default.trim() }
      : {}),
    configRoot: root,
  };
}

function readSecrets(root: string): Record<string, unknown> | null {
  const secretsPath = path.join(root, 'secrets.json');
  try {
    if (!fs.existsSync(secretsPath)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(secretsPath, 'utf-8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Whether a provider has an API key.
 *
 * `secrets.json` stores FLAT dotted keys (`providers.minimax-cn.apiKey`), so
 * the lookup has to build the dotted name — reading `secrets.providers[id]`
 * silently returns undefined and every provider looks keyless.
 */
function hasApiKey(secrets: Record<string, unknown> | null, providerId: string): boolean {
  if (secrets === null) return false;
  const key = getSecret(secrets, `providers.${providerId}.apiKey`);
  return typeof key === 'string' && key.trim() !== '';
}
