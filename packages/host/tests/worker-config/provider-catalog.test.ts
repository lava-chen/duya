/**
 * Tests for the configured provider catalog.
 *
 * The bug this reader replaces: the model picker asked the Host's
 * `provider_model_capabilities` table, which holds OVERRIDES written by the
 * Desktop provider editor. On a machine whose providers came from
 * `config.toml` — every CLI-only install — that table is empty, so the
 * picker reported "no models registered" exactly where the most models were
 * configured.
 *
 * So these tests assert the thing that was broken: the catalog lists the
 * providers the CONFIGURATION declares, their models, the facts a
 * configuration file cannot carry (context window, reasoning, thinking
 * tiers), and the presets a vendor serves that nobody typed into the file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readProviderCatalog } from '../../src/worker-config/provider-catalog.js';

let tmpRoot: string;

function writeConfig(toml: string): void {
  fs.writeFileSync(path.join(tmpRoot, 'config.toml'), toml, 'utf-8');
}

/** Secrets as the desktop actually writes them: FLAT dotted keys. */
function writeSecrets(flat: Record<string, string>): void {
  fs.writeFileSync(path.join(tmpRoot, 'secrets.json'), JSON.stringify(flat, null, 2), 'utf-8');
}

const REAL_CONFIG = `
[model]
  default = "MiniMax-M3"
  provider = "minimax-cn"

[providers.minimax-cn]
  id = "minimax-cn"
  name = "MiniMax CN"
  providerType = "anthropic"
  baseUrl = "https://api.minimaxi.com/anthropic"
  [providers.minimax-cn.options]
  enabled_models = [ "MiniMax-M3", "MiniMax-M2.7" ]

[providers.openrouter]
  id = "openrouter"
  name = "OpenRouter"
  providerType = "openrouter"
  baseUrl = "https://openrouter.ai/api/v1"
  [providers.openrouter.options]
  enabled_models = [ "qwen/qwen3.8-27b" ]
  defaultModel = "qwen/qwen3.8-27b"
    [providers.openrouter.options.model_context]
    "qwen/qwen3.8-27b" = 1_000_000
`;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-provider-catalog-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('readProviderCatalog', () => {
  it('lists every configured provider with its models', () => {
    writeConfig(REAL_CONFIG);
    writeSecrets({ 'providers.minimax-cn.apiKey': 'sk-real-key' });

    const catalog = readProviderCatalog(tmpRoot);
    expect(catalog.error).toBeUndefined();
    expect(catalog.providers.map((provider) => provider.providerId)).toEqual([
      'minimax-cn',
      'openrouter',
    ]);
    expect(catalog.activeProviderId).toBe('minimax-cn');
    expect(catalog.activeModel).toBe('MiniMax-M3');
    const minimax = catalog.providers[0];
    expect(minimax?.name).toBe('MiniMax CN');
    expect(minimax?.models.map((model) => model.modelId)).toEqual(['MiniMax-M3', 'MiniMax-M2.7']);
  });

  it('reads the API key from the FLAT secrets key, so a provider is not reported keyless', () => {
    writeConfig(REAL_CONFIG);
    writeSecrets({ 'providers.minimax-cn.apiKey': 'sk-real-key' });

    const catalog = readProviderCatalog(tmpRoot);
    const minimax = catalog.providers.find((provider) => provider.providerId === 'minimax-cn');
    const openrouter = catalog.providers.find((provider) => provider.providerId === 'openrouter');
    expect(minimax?.hasApiKey).toBe(true);
    // The other provider has no key — and that has to be visible, not assumed.
    expect(openrouter?.hasApiKey).toBe(false);
  });

  it('takes the context window from the configuration when it states one', () => {
    writeConfig(REAL_CONFIG);

    const catalog = readProviderCatalog(tmpRoot);
    const openrouter = catalog.providers.find((provider) => provider.providerId === 'openrouter');
    const model = openrouter?.models.find((entry) => entry.modelId === 'qwen/qwen3.8-27b');
    expect(model?.contextWindow).toBe(1_000_000);
    expect(openrouter?.defaultModel).toBe('qwen/qwen3.8-27b');
  });

  it('completes a model with the built-in directory: reasoning and thinking tiers', () => {
    writeConfig(REAL_CONFIG);

    const catalog = readProviderCatalog(tmpRoot);
    const minimax = catalog.providers.find((provider) => provider.providerId === 'minimax-cn');
    const model = minimax?.models.find((entry) => entry.modelId === 'MiniMax-M3');
    expect(model?.supportsReasoning).toBe(true);
    // The built-in ladder for MiniMax M3: low, medium, high, max.
    expect(model?.reasoningEffortOptions).toEqual(['low', 'medium', 'high', 'max']);
    expect(model?.contextWindow).toBe(1_000_000);
  });

  it('offers the vendor presets the configuration never typed out', () => {
    writeConfig(REAL_CONFIG);

    const catalog = readProviderCatalog(tmpRoot);
    const minimax = catalog.providers.find((provider) => provider.providerId === 'minimax-cn');
    // The built-in MiniMax CN list, minus the two rows `enabled_models` already
    // claims. A preset is not a duplicate of a configured model.
    expect(minimax?.presetModels?.map((model) => model.modelId)).toEqual([
      'MiniMax-M3.1-Flash',
      'MiniMax-M2.5',
      'MiniMax-M2.1',
      'MiniMax-M2',
    ]);
    // Presets carry the same facts as configured rows, because the picker has
    // to show what switching to one would mean.
    const preset = minimax?.presetModels?.find((model) => model.modelId === 'MiniMax-M2.5');
    expect(preset?.contextWindow).toBeGreaterThan(0);
  });

  it('resolves a preset entry by id prefix when the catalog splits one vendor across endpoints', () => {
    writeConfig(`
[providers.glm]
  id = "glm"
  name = "GLM"
  providerType = "openai-compatible"
  [providers.glm.options]
  enabled_models = [ "glm-4.6" ]
`);

    const catalog = readProviderCatalog(tmpRoot);
    const presets = catalog.providers[0]?.presetModels ?? [];
    // `glm` matches no entry exactly, so it takes the first extension —
    // `glm-cn`. Two regions' lists merged into one would be a row that looks
    // right and bills differently.
    expect(presets.length).toBeGreaterThan(0);
    expect(presets.map((model) => model.modelId)).not.toContain('glm-4.6');
  });

  it('invents no presets for a provider the built-in catalog does not know', () => {
    writeConfig(`
[providers.my-proxy]
  id = "my-proxy"
  name = "Local proxy"
  providerType = "openai-compatible"
  [providers.my-proxy.options]
  enabled_models = [ "some-model" ]
`);

    const catalog = readProviderCatalog(tmpRoot);
    // A custom baseUrl is not `openrouter`; suggesting its models would put
    // rows on screen the endpoint does not serve.
    expect(catalog.providers[0]?.presetModels).toBeUndefined();
  });

  it('reports a missing configuration by naming the file, not as an empty catalog', () => {
    const catalog = readProviderCatalog(tmpRoot);
    expect(catalog.providers).toEqual([]);
    expect(catalog.error).toContain(path.join(tmpRoot, 'config.toml'));
  });

  it('reports a malformed configuration by naming the file', () => {
    writeConfig('[providers.broken\n  id = "x"');
    const catalog = readProviderCatalog(tmpRoot);
    expect(catalog.providers).toEqual([]);
    expect(catalog.error).toContain('not valid TOML');
  });
});
