/**
 * Tests for the file-backed CLI config reader.
 *
 * The bug this module fixes was a SILENT EMPTY RESULT: the old reader
 * succeeded, returned zero rows, and the CLI printed the generic "API key is
 * required". So several tests here assert on the specific failure reason, not
 * merely on "it returned null" — a reader that returns null for the wrong
 * reason must not pass.
 *
 * Each test gets its own config root via the injectable `configRootOverride`
 * seam (the same one `readToolExposureConfig` / `readDecisionsConfig` use),
 * because `resolveConfigRoot()` is fixed to `~/.duya`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveProvider,
  resolveModel,
  mapProviderType,
  getSecret,
  readCliSettings,
  type ProviderResolution,
} from '../file-config.js';

let tmpRoot: string;

function writeConfig(toml: string): void {
  fs.writeFileSync(path.join(tmpRoot, 'config.toml'), toml, 'utf-8');
}

/** Secrets as the desktop actually writes them: FLAT dotted keys. */
function writeSecrets(flat: Record<string, string>): void {
  fs.writeFileSync(path.join(tmpRoot, 'secrets.json'), JSON.stringify(flat, null, 2), 'utf-8');
}

/** The user's real config, trimmed to the parts resolution depends on. */
const REAL_CONFIG = `
[model]
  default = "claude-sonnet-4"
  provider = "minimax-cn"
  base_url = "https://api.minimaxi.com/anthropic"

[providers.minimax-cn]
  id = "minimax-cn"
  name = "MiniMax CN"
  providerType = "anthropic"
  baseUrl = "https://api.minimaxi.com/anthropic"
  [providers.minimax-cn.options]
  enabled_models = [ "MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.1" ]

[providers.deepseek]
  id = "deepseek"
  name = "DeepSeek"
  providerType = "openai-compatible"
  baseUrl = "https://api.deepseek.com/v1"
  [providers.deepseek.options]
  enabled_models = [ "deepseek-flash", "deepseek-v4-pro" ]
  defaultModel = "deepseek-flash"
`;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-cli-provider-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function expectOk(res: ProviderResolution) {
  if (!res.ok) {
    throw new Error(`expected resolution to succeed, got ${res.reason}: ${res.message}`);
  }
  return res.provider;
}

describe('resolveProvider (the reported bug)', () => {
  it('resolves the active provider from config.toml + flat secrets.json', () => {
    writeConfig(REAL_CONFIG);
    writeSecrets({ 'providers.minimax-cn.apiKey': 'sk-real-key' });

    const p = expectOk(resolveProvider(undefined, tmpRoot));
    expect(p.id).toBe('minimax-cn');
    expect(p.apiKey).toBe('sk-real-key');
    expect(p.protocol).toBe('anthropic');
    expect(p.baseUrl).toBe('https://api.minimaxi.com/anthropic');
  });

  it('falls back to [model].base_url when the provider omits baseUrl', () => {
    writeConfig(`
[model]
  default = "m1"
  provider = "p1"
  base_url = "https://fallback.example/anthropic"
[providers.p1]
  providerType = "anthropic"
`);
    writeSecrets({ 'providers.p1.apiKey': 'k' });
    expect(expectOk(resolveProvider(undefined, tmpRoot)).baseUrl).toBe('https://fallback.example/anthropic');
  });

  it('prefers the provider baseUrl over the [model] one', () => {
    writeConfig(`
[model]
  default = "m1"
  provider = "p1"
  base_url = "https://global.example"
[providers.p1]
  providerType = "anthropic"
  baseUrl = "https://per-provider.example"
`);
    writeSecrets({ 'providers.p1.apiKey': 'k' });
    expect(expectOk(resolveProvider(undefined, tmpRoot)).baseUrl).toBe('https://per-provider.example');
  });

  it('reads the flat dotted secret key, NOT a nested providers[id].apiKey lookup', () => {
    writeConfig(REAL_CONFIG);
    // Flat key only. A reader written as `secrets.providers[id].apiKey`
    // returns undefined here and fails to resolve.
    writeSecrets({ 'providers.minimax-cn.apiKey': 'sk-flat-key' });
    expect(expectOk(resolveProvider(undefined, tmpRoot)).apiKey).toBe('sk-flat-key');
  });

  it('still accepts a nested secrets object (hand-written files)', () => {
    writeConfig(REAL_CONFIG);
    fs.writeFileSync(
      path.join(tmpRoot, 'secrets.json'),
      JSON.stringify({ providers: { 'minimax-cn': { apiKey: 'sk-nested' } } }),
      'utf-8',
    );
    expect(expectOk(resolveProvider(undefined, tmpRoot)).apiKey).toBe('sk-nested');
  });
});

describe('model resolution', () => {
  it('prefers an explicit --model over everything else', () => {
    writeConfig(REAL_CONFIG);
    writeSecrets({ 'providers.minimax-cn.apiKey': 'k' });
    const p = expectOk(resolveProvider('MiniMax-M2.7', tmpRoot));
    expect(p.model.model).toBe('MiniMax-M2.7');
    expect(p.model.source).toBe('flag');
  });

  it('uses options.defaultModel when no flag is given', () => {
    writeConfig(`
[model]
  provider = "deepseek"
[providers.deepseek]
  providerType = "openai-compatible"
  [providers.deepseek.options]
  enabled_models = [ "deepseek-flash", "deepseek-v4-pro" ]
  defaultModel = "deepseek-v4-pro"
`);
    writeSecrets({ 'providers.deepseek.apiKey': 'k' });
    const p = expectOk(resolveProvider(undefined, tmpRoot));
    expect(p.model.model).toBe('deepseek-v4-pro');
    expect(p.model.source).toBe('provider-default');
  });

  it('falls back to enabled_models[0] when the provider has no defaultModel', () => {
    // This is the user's real minimax-cn shape: enabled_models, no defaultModel.
    writeConfig(REAL_CONFIG);
    writeSecrets({ 'providers.minimax-cn.apiKey': 'k' });
    const p = expectOk(resolveProvider(undefined, tmpRoot));
    expect(p.model.model).toBe('MiniMax-M3');
    expect(p.model.source).toBe('enabled-models');
  });

  it('warns when [model].default is not in enabled_models, and reports the source', () => {
    // enabled_models outranks [model].default, so reaching the config-default
    // branch with a non-empty enabled_models is only possible when the list
    // exists but is empty of strings. The real-world shape this guards is a
    // provider whose list does NOT contain the global default.
    writeConfig(`
[model]
  default = "claude-sonnet-4"
  provider = "solo"
[providers.solo]
  providerType = "anthropic"
  [providers.solo.options]
  enabled_models = [ ]
`);
    writeSecrets({ 'providers.solo.apiKey': 'k' });
    const p = expectOk(resolveProvider(undefined, tmpRoot));
    expect(p.model.model).toBe('claude-sonnet-4');
    expect(p.model.source).toBe('config-default');
    // No served list to compare against: use it, but do not claim it is wrong.
    expect(p.model.warning).toBeUndefined();
  });

  it('warns when an explicit --model is not served by the provider', () => {
    // The user's real trap, entered explicitly: --model claude-sonnet-4
    // against a MiniMax provider that serves only MiniMax-* models.
    writeConfig(REAL_CONFIG);
    writeSecrets({ 'providers.minimax-cn.apiKey': 'k' });
    const p = expectOk(resolveProvider('claude-sonnet-4', tmpRoot));
    expect(p.model.model).toBe('claude-sonnet-4');
    expect(p.model.source).toBe('flag');
    expect(p.model.warning).toBeDefined();
    expect(p.model.warning).toContain('claude-sonnet-4');
    expect(p.model.warning).toContain('MiniMax-M3');
    expect(p.model.warning).toContain('--model');
  });

  it('warns when options.defaultModel is not in enabled_models', () => {
    writeConfig(`
[model]
  provider = "ds"
[providers.ds]
  providerType = "openai-compatible"
  [providers.ds.options]
  enabled_models = [ "served-a", "served-b" ]
  defaultModel = "retired-model"
`);
    writeSecrets({ 'providers.ds.apiKey': 'k' });
    const p = expectOk(resolveProvider(undefined, tmpRoot));
    expect(p.model.model).toBe('retired-model');
    expect(p.model.source).toBe('provider-default');
    expect(p.model.warning).toContain('retired-model');
    expect(p.model.warning).toContain('served-a');
  });

  it('does not warn when [model].default IS served', () => {
    writeConfig(`
[model]
  default = "served"
  provider = "p"
[providers.p]
  providerType = "anthropic"
  [providers.p.options]
  enabled_models = [ "served", "other" ]
`);
    writeSecrets({ 'providers.p.apiKey': 'k' });
    const p = expectOk(resolveProvider(undefined, tmpRoot));
    expect(p.model.warning).toBeUndefined();
  });

  it('resolveModel() ordering: flag > defaultModel > enabled_models[0] > config default', () => {
    const opts = { defaultModel: 'D', enabled_models: ['E0', 'E1'] };
    expect(resolveModel('FLAG', opts, 'CFG').model).toBe('FLAG');
    expect(resolveModel(undefined, opts, 'CFG').model).toBe('D');
    expect(resolveModel(undefined, { enabled_models: ['E0'] }, 'CFG').model).toBe('E0');
    expect(resolveModel(undefined, undefined, 'CFG').model).toBe('CFG');
  });
});

describe('providerType mapping', () => {
  it('maps all three observed values onto the flag vocabulary', () => {
    expect(mapProviderType('anthropic')).toBe('anthropic');
    expect(mapProviderType('openai-compatible')).toBe('openai');
    expect(mapProviderType('openrouter')).toBe('openai');
  });

  it('maps case-insensitively and accepts plain openai', () => {
    expect(mapProviderType('OpenRouter')).toBe('openai');
    expect(mapProviderType('  ANTHROPIC ')).toBe('anthropic');
    expect(mapProviderType('openai')).toBe('openai');
  });

  it('returns undefined for an unknown or missing type (never passes it through)', () => {
    expect(mapProviderType('bedrock-v2')).toBeUndefined();
    expect(mapProviderType(undefined)).toBeUndefined();
    expect(mapProviderType('openai-compatible-ish')).toBeUndefined();
  });

  it('fails resolution with a message naming the bad type instead of passing it through', () => {
    writeConfig(`
[model]
  provider = "weird"
[providers.weird]
  providerType = "bedrock-v2"
`);
    writeSecrets({ 'providers.weird.apiKey': 'k' });
    const res = resolveProvider(undefined, tmpRoot);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('provider-unknown');
    expect(res.message).toContain('bedrock-v2');
  });
});

describe('failure modes each name the real cause', () => {
  it('config-missing names the path it looked at', () => {
    const res = resolveProvider(undefined, tmpRoot);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('config-missing');
    expect(res.message).toContain(path.join(tmpRoot, 'config.toml'));
  });

  it('secrets-missing says the key lives in secrets.json, not "API key is required"', () => {
    writeConfig(REAL_CONFIG);
    const res = resolveProvider(undefined, tmpRoot);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('secrets-missing');
    expect(res.message).toContain('secrets.json');
    expect(res.message).not.toMatch(/^API key is required/);
  });

  it('api-key-missing names the exact flat key expected', () => {
    writeConfig(REAL_CONFIG);
    writeSecrets({ 'providers.deepseek.apiKey': 'other' });
    const res = resolveProvider(undefined, tmpRoot);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('api-key-missing');
    expect(res.message).toContain('providers.minimax-cn.apiKey');
  });

  it('config-malformed names the file and the parse error', () => {
    writeConfig('this is [not valid toml {{{');
    const res = resolveProvider(undefined, tmpRoot);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('config-malformed');
    expect(res.message).toContain('config.toml');
    expect(res.message).toContain('TOML');
  });

  it('secrets-malformed is distinct from secrets-missing', () => {
    writeConfig(REAL_CONFIG);
    fs.writeFileSync(path.join(tmpRoot, 'secrets.json'), '{ not json', 'utf-8');
    const res = resolveProvider(undefined, tmpRoot);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('secrets-malformed');
  });

  it('provider-unknown lists the providers that do exist', () => {
    writeConfig(`
[model]
  provider = "ghost"
[providers.real]
  providerType = "anthropic"
`);
    writeSecrets({ 'providers.real.apiKey': 'k' });
    const res = resolveProvider(undefined, tmpRoot);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('provider-unknown');
    expect(res.message).toContain('ghost');
    expect(res.message).toContain('real');
  });

  it('no-provider-selected when [model].provider is absent', () => {
    writeConfig('[model]\n  default = "x"\n[providers.p]\n  providerType = "anthropic"\n');
    writeSecrets({ 'providers.p.apiKey': 'k' });
    const res = resolveProvider(undefined, tmpRoot);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('no-provider-selected');
  });

  it('model-unresolved when nothing names a model', () => {
    writeConfig('[model]\n  provider = "p"\n[providers.p]\n  providerType = "anthropic"\n');
    writeSecrets({ 'providers.p.apiKey': 'k' });
    const res = resolveProvider(undefined, tmpRoot);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('model-unresolved');
    expect(res.message).toContain('--model');
  });

  it('the real config resolves OK - guards against the whole class regressing', () => {
    writeConfig(REAL_CONFIG);
    writeSecrets({
      'providers.deepseek.apiKey': 'k1',
      'providers.minimax-cn.apiKey': 'k2',
    });
    const res = resolveProvider(undefined, tmpRoot);
    expect(res.ok).toBe(true);
  });
});

describe('getSecret flat-vs-nested trap', () => {
  it('reads the flat key', () => {
    expect(getSecret({ 'providers.x.apiKey': 'flat' }, 'providers.x.apiKey')).toBe('flat');
  });

  it('reads a nested object', () => {
    expect(getSecret({ providers: { x: { apiKey: 'nested' } } }, 'providers.x.apiKey')).toBe('nested');
  });

  it('prefers the flat key when both shapes exist', () => {
    const doc = { 'providers.x.apiKey': 'flat', providers: { x: { apiKey: 'nested' } } };
    expect(getSecret(doc, 'providers.x.apiKey')).toBe('flat');
  });

  it('returns undefined for a missing or non-string value', () => {
    expect(getSecret({}, 'providers.x.apiKey')).toBeUndefined();
    expect(getSecret(null, 'providers.x.apiKey')).toBeUndefined();
    expect(getSecret({ 'providers.x.apiKey': 42 }, 'providers.x.apiKey')).toBeUndefined();
  });
});

describe('readCliSettings', () => {
  it('reads agent.max_turns from config.toml', () => {
    writeConfig('[agent]\n  max_turns = 12\n');
    expect(readCliSettings(tmpRoot).maxTurns).toBe(12);
  });

  it('leaves maxTurns undefined (uncapped) when unset - never a silent 0', () => {
    writeConfig('[agent]\n  gateway_timeout = 30\n');
    expect(readCliSettings(tmpRoot).maxTurns).toBeUndefined();
  });

  it('lists mcp_servers names from config.toml', () => {
    writeConfig('[mcp_servers.alpha]\n  command = "node"\n[mcp_servers.beta]\n  command = "node"\n');
    expect(readCliSettings(tmpRoot).mcpServerNames).toEqual(['alpha', 'beta']);
  });

  it('degrades safely on malformed TOML', () => {
    writeConfig('[[[ not toml');
    const s = readCliSettings(tmpRoot);
    expect(s.maxTurns).toBeUndefined();
    expect(s.mcpServerNames).toEqual([]);
  });
});