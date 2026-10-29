/**
 * The provider write side of `config.toml` and `secrets.json` (plan 632).
 *
 * ## Why this file exists
 *
 * Before this slice the only code that could add or edit a provider ran inside
 * Electron, and it rewrote the whole document through `ConfigStore`. The Host
 * write path has to keep the guarantees the hand-edited file depends on, and
 * each one is a case here:
 *   - a mutation replaces ONLY `[providers.*]` / `[model]`: every other table,
 *     every comment, and every field this surface does not name survives;
 *   - the key goes to `secrets.json` and never appears in `config.toml`, in a
 *     read, or in an error message;
 *   - a key that is already sitting in the TOML row is carried to the secrets
 *     file instead of being dropped, because dropping it would silently
 *     unconfigure a provider the user never asked to change;
 *   - a file this surface cannot write back over is refused, not repaired.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from '@iarna/toml';
import {
  allocateProviderId,
  createHostLocalProviderManagementApi,
  HostProviderApiError,
} from '../src/provider-management/index.js';
import type { FetchLike } from '../src/provider-management/index.js';

const OPENAI_KEY = 'sk-real-openai-key-abcdefghij';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'duya-provider-write-'));
}

function configPath(root: string): string {
  return path.join(root, 'config.toml');
}

function secretsPath(root: string): string {
  return path.join(root, 'secrets.json');
}

function readConfig(root: string): string {
  return fs.readFileSync(configPath(root), 'utf8');
}

function readSecrets(root: string): Record<string, unknown> {
  if (!fs.existsSync(secretsPath(root))) return {};
  return JSON.parse(fs.readFileSync(secretsPath(root), 'utf8')) as Record<string, unknown>;
}

function readProviders(root: string): Record<string, Record<string, unknown>> {
  const doc = parse(readConfig(root)) as { providers?: Record<string, Record<string, unknown>> };
  return doc.providers ?? {};
}

function readModel(root: string): Record<string, unknown> {
  const doc = parse(readConfig(root)) as { model?: Record<string, unknown> };
  return doc.model ?? {};
}

/** Both files as one document, so a case can assert on the raw bytes. */
function seed(root: string, config: string, secrets?: Record<string, unknown>): void {
  fs.writeFileSync(configPath(root), config, 'utf8');
  if (secrets !== undefined) {
    fs.writeFileSync(secretsPath(root), `${JSON.stringify(secrets, null, 2)}\n`, 'utf8');
  }
}

const SEED_CONFIG = [
  '# the note above everything',
  '_config_version = 1',
  '',
  '[model]',
  'default = "gpt-4o-mini"',
  'provider = "openai"',
  'base_url = "https://api.openai.com/v1"',
  '',
  '# a local server configured by hand',
  '[providers.ollama]',
  'id = "ollama"',
  'name = "Ollama"',
  'providerType = "ollama"',
  'baseUrl = "http://127.0.0.1:11434"',
  '',
  '[providers.openai]',
  'id = "openai"',
  'name = "OpenAI"',
  'providerType = "openai"',
  'baseUrl = "https://api.openai.com/v1"',
  '',
  '  [providers.openai.options]',
  '  enabled_models = [ "gpt-4o-mini" ]',
  '  model_context = 128000',
  '',
  '[storage]',
  'database_path = "duya-main.db"',
  '',
].join('\n');

const SEED_SECRETS = { 'providers.openai.apiKey': OPENAI_KEY };

/** A fetch that answers whatever the case needs, and records what it was asked. */
function fakeFetch(
  handler: (url: string, headers: Record<string, string>) => { status: number; body: unknown },
  seen: { url: string; headers: Record<string, string> }[] = [],
): FetchLike {
  return async (url, init) => {
    seen.push({ url, headers: init.headers });
    const answer = handler(url, init.headers);
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => answer.body,
    };
  };
}

describe('provider list', () => {
  it('projects both files and never hands back a key', async () => {
    const root = tmpRoot();
    seed(root, SEED_CONFIG, SEED_SECRETS);

    const list = await createHostLocalProviderManagementApi({ root }).listProviders();

    expect(list.activeProviderId).toBe('openai');
    expect(list.activeModel).toBe('gpt-4o-mini');
    expect(list.configRoot).toBe(root);
    expect(list.revision).not.toBe('');
    expect(list.error).toBeUndefined();

    const openai = list.providers.find((row) => row.providerId === 'openai')!;
    expect(openai).toMatchObject({
      name: 'OpenAI',
      providerType: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      models: ['gpt-4o-mini'],
      hasApiKey: true,
      isDefault: true,
    });
    expect(openai.maskedApiKey).toContain('***');

    const ollama = list.providers.find((row) => row.providerId === 'ollama')!;
    expect(ollama).toMatchObject({ hasApiKey: false, isDefault: false });
    expect(ollama.maskedApiKey).toBe('');
    // The whole answer, serialized, is what a client would print or log.
    expect(JSON.stringify(list)).not.toContain(OPENAI_KEY);
  });

  it('explains an unreadable file instead of returning an empty list', async () => {
    const root = tmpRoot();
    seed(root, 'this is not = = toml\n');

    const list = await createHostLocalProviderManagementApi({ root }).listProviders();

    expect(list.providers).toEqual([]);
    expect(list.error).toBeDefined();
  });

  it('sees a key written in the nested spelling', async () => {
    const root = tmpRoot();
    seed(root, SEED_CONFIG);
    fs.writeFileSync(
      secretsPath(root),
      `${JSON.stringify({ providers: { openai: { apiKey: OPENAI_KEY } } }, null, 2)}\n`,
      'utf8',
    );

    const list = await createHostLocalProviderManagementApi({ root }).listProviders();

    // The worker's `getSecret` accepts this spelling, so the list must not
    // claim the provider is unconfigured.
    expect(list.providers.find((row) => row.providerId === 'openai')!.hasApiKey).toBe(true);
  });
});

describe('provider upsert', () => {
  it('keeps every other table and comment when adding a provider', async () => {
    const root = tmpRoot();
    seed(root, SEED_CONFIG, SEED_SECRETS);

    const before = readConfig(root);
    const { provider } = await createHostLocalProviderManagementApi({ root }).upsertProvider({
      name: 'DeepSeek',
      providerType: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      models: ['deepseek-chat'],
      defaultModel: 'deepseek-chat',
      apiKey: 'sk-deepseek-key',
    });

    expect(provider.providerId).toBe('deepseek');
    const after = readConfig(root);
    expect(after).toContain('# the note above everything');
    expect(after).toContain('# a local server configured by hand');
    expect(after).toContain('base_url = "https://api.openai.com/v1"');
    expect(after).toContain('database_path = "duya-main.db"');
    // Everything outside `[providers.*]` is the text that was already there;
    // the one liberty the editor takes is a blank line before the block it
    // rewrites, which is layout and not content.
    const preamble = (text: string): string =>
      text.slice(0, text.indexOf('[providers.')).replace(/\s+$/, '');
    expect(preamble(after)).toBe(preamble(before));
    expect(after.slice(after.indexOf('[storage]'))).toBe(before.slice(before.indexOf('[storage]')));
    // The rows this write did not name came back with their fields intact.
    expect(readProviders(root).ollama).toMatchObject({
      name: 'Ollama',
      providerType: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
    });
    expect(readProviders(root).openai).toMatchObject({ name: 'OpenAI' });
    expect(readModel(root)).toEqual(parse(SEED_CONFIG).model);
  });

  it('puts the key in secrets.json and nowhere else', async () => {
    const root = tmpRoot();
    seed(root, SEED_CONFIG);

    await createHostLocalProviderManagementApi({ root }).upsertProvider({
      providerId: 'deepseek',
      name: 'DeepSeek',
      providerType: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-deepseek-abcdefghij',
    });

    expect(readSecrets(root)).toMatchObject({ 'providers.deepseek.apiKey': 'sk-deepseek-abcdefghij' });
    expect(readConfig(root)).not.toContain('sk-deepseek-abcdefghij');
    expect(readProviders(root).deepseek).not.toHaveProperty('apiKey');
  });

  it('carries a key that is already in the TOML row into secrets.json', async () => {
    const root = tmpRoot();
    seed(
      root,
      [
        '[providers.legacy]',
        'id = "legacy"',
        'name = "Legacy"',
        'providerType = "openai"',
        'baseUrl = "https://legacy.example.com/v1"',
        'apiKey = "sk-legacy-in-toml-1234"',
        '',
      ].join('\n'),
    );

    const api = createHostLocalProviderManagementApi({ root });
    const { provider } = await api.upsertProvider({
      providerId: 'legacy',
      name: 'Legacy Renamed',
      providerType: 'openai',
      baseUrl: 'https://legacy.example.com/v1',
    });

    expect(provider.providerId).toBe('legacy');
    expect(readSecrets(root)['providers.legacy.apiKey']).toBe('sk-legacy-in-toml-1234');
    expect(readConfig(root)).not.toContain('sk-legacy-in-toml-1234');
  });

  it('omitting the key keeps it and an empty string clears it', async () => {
    const root = tmpRoot();
    seed(root, SEED_CONFIG, SEED_SECRETS);
    const api = createHostLocalProviderManagementApi({ root });

    const renamed = await api.upsertProvider({
      providerId: 'openai',
      name: 'OpenAI Work',
      providerType: 'openai',
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(renamed.provider.hasApiKey).toBe(true);
    expect(readSecrets(root)['providers.openai.apiKey']).toBe(OPENAI_KEY);

    const cleared = await api.upsertProvider({
      providerId: 'openai',
      name: 'OpenAI Work',
      providerType: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
    });
    expect(cleared.provider.hasApiKey).toBe(false);
    expect(readSecrets(root)['providers.openai.apiKey']).toBeUndefined();
  });

  it('clears a key spelled in either form', async () => {
    const root = tmpRoot();
    seed(root, SEED_CONFIG);
    fs.writeFileSync(
      secretsPath(root),
      `${JSON.stringify({ providers: { openai: { apiKey: OPENAI_KEY } } }, null, 2)}\n`,
      'utf8',
    );

    const cleared = await createHostLocalProviderManagementApi({ root }).upsertProvider({
      providerId: 'openai',
      name: 'OpenAI',
      providerType: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
    });

    // Clearing only the flat spelling would leave this readable by the worker.
    expect(cleared.provider.hasApiKey).toBe(false);
    expect(readSecrets(root)).toEqual({});
  });

  it('refuses a key that is really the mask it just read', async () => {
    const root = tmpRoot();
    seed(root, SEED_CONFIG, SEED_SECRETS);

    const error = await createHostLocalProviderManagementApi({ root })
      .upsertProvider({
        providerId: 'openai',
        name: 'OpenAI',
        providerType: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-r***ghij',
      })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(HostProviderApiError);
    expect((error as HostProviderApiError).code).toBe('masked_api_key');
    expect((error as HostProviderApiError).status).toBe(400);
    expect(readSecrets(root)['providers.openai.apiKey']).toBe(OPENAI_KEY);
  });

  it('keeps fields it does not name and replaces the ones it does', async () => {
    const root = tmpRoot();
    seed(root, SEED_CONFIG, SEED_SECRETS);

    await createHostLocalProviderManagementApi({ root }).upsertProvider({
      providerId: 'openai',
      name: 'OpenAI',
      alias: 'work',
      providerType: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      models: ['gpt-5', 'gpt-4o'],
    });

    const entry = readProviders(root).openai!;
    // `model_context` is a hand-written option this surface never mentions.
    expect((entry.options as Record<string, unknown>).model_context).toBe(128000);
    expect(entry.options).toMatchObject({ enabled_models: ['gpt-5', 'gpt-4o'] });
    // An empty list is a declaration, not a no-op: the row stops advertising.
    expect((entry.options as Record<string, unknown>).defaultModel).toBeUndefined();
    expect(entry.alias).toBe('work');
  });

  it('refuses a write when the file changed since the caller read it', async () => {
    const root = tmpRoot();
    seed(root, SEED_CONFIG, SEED_SECRETS);
    const api = createHostLocalProviderManagementApi({ root });

    const stale = (await api.listProviders()).revision;
    fs.appendFileSync(
      configPath(root),
      '[providers.hand-written]\nid = "hand-written"\nname = "Hand"\nproviderType = "openai"\n' +
        'baseUrl = "https://hand.example.com/v1"\n',
      'utf8',
    );

    const error = await api
      .upsertProvider({
        providerId: 'openai',
        name: 'OpenAI',
        providerType: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        expectedRevision: stale,
      })
      .catch((thrown: unknown) => thrown);

    expect((error as HostProviderApiError).code).toBe('provider_revision_conflict');
    expect((error as HostProviderApiError).status).toBe(409);
  });

  it('refuses a document whose providers are not a table', async () => {
    const root = tmpRoot();
    seed(root, '[[providers]]\nname = "Array of tables"\n');

    const error = await createHostLocalProviderManagementApi({ root })
      .upsertProvider({
        name: 'Any',
        providerType: 'openai',
        baseUrl: 'https://api.openai.com/v1',
      })
      .catch((thrown: unknown) => thrown);

    expect((error as HostProviderApiError).code).toBe('provider_config_unwritable');
    expect(readConfig(root)).toBe('[[providers]]\nname = "Array of tables"\n');
  });

  it('refuses a secrets.json that does not parse rather than starting from empty', async () => {
    const root = tmpRoot();
    seed(root, SEED_CONFIG);
    fs.writeFileSync(secretsPath(root), '{"providers.openai.apiKey": ', 'utf8');

    const error = await createHostLocalProviderManagementApi({ root })
      .upsertProvider({
        name: 'Any',
        providerType: 'openai',
        baseUrl: 'https://api.openai.com/v1',
      })
      .catch((thrown: unknown) => thrown);

    expect((error as HostProviderApiError).code).toBe('provider_config_unwritable');
    expect(fs.readFileSync(secretsPath(root), 'utf8')).toBe('{"providers.openai.apiKey": ');
  });

  it('refuses an id that could not be written back as a table header', async () => {
    const root = tmpRoot();
    seed(root, SEED_CONFIG, SEED_SECRETS);

    await expect(
      createHostLocalProviderManagementApi({ root }).upsertProvider({
        providerId: 'oops"].x',
        name: 'Oops',
        providerType: 'openai',
        baseUrl: 'https://api.openai.com/v1',
      }),
    ).rejects.toThrow(/provider id/);
    expect(readConfig(root)).toBe(SEED_CONFIG);
  });

  it('allocates a unique id from the name instead of overwriting a row', () => {
    const fresh = allocateProviderId('OpenAI', {});
    const first = allocateProviderId('OpenAI', { [fresh]: {} });

    expect(fresh).toBe('openai');
    expect(first).not.toBe('openai');
    expect(first.startsWith('openai-')).toBe(true);
  });

  it('creates the config file on the first provider', async () => {
    const root = tmpRoot();

    const { provider } = await createHostLocalProviderManagementApi({ root }).upsertProvider({
      name: 'First',
      providerType: 'openai-compatible',
      baseUrl: 'https://first.example.com/v1',
      apiKey: 'sk-first-key-value',
    });

    expect(provider.providerId).toBe('first');
    expect(readProviders(root).first).toMatchObject({ name: 'First' });
    expect(readSecrets(root)['providers.first.apiKey']).toBe('sk-first-key-value');
  });
});

describe('provider delete and default', () => {
  it('removes the row and its key', async () => {
    const root = tmpRoot();
    seed(root, SEED_CONFIG, SEED_SECRETS);

    const result = await createHostLocalProviderManagementApi({ root }).deleteProvider('openai');

    expect(result.clearedDefault).toBe(true);
    expect(readProviders(root).openai).toBeUndefined();
    expect(readProviders(root).ollama).toBeDefined();
    expect(readSecrets(root)['providers.openai.apiKey']).toBeUndefined();
    expect(readSecrets(root)).not.toHaveProperty('providers.openai.apiKey');
    expect(result.revision).not.toBe('');
  });

  it('clears the pointer but leaves the model choice alone', async () => {
    const root = tmpRoot();
    seed(root, SEED_CONFIG, SEED_SECRETS);

    await createHostLocalProviderManagementApi({ root }).deleteProvider('openai');

    expect(readModel(root)).toMatchObject({
      provider: '',
      default: 'gpt-4o-mini',
      base_url: 'https://api.openai.com/v1',
    });
  });

  it('refuses to delete a provider that is not there', async () => {
    const root = tmpRoot();
    seed(root, SEED_CONFIG, SEED_SECRETS);

    const error = await createHostLocalProviderManagementApi({ root })
      .deleteProvider('ghost')
      .catch((thrown: unknown) => thrown);

    expect((error as HostProviderApiError).status).toBe(404);
    expect(readConfig(root)).toBe(SEED_CONFIG);
  });

  it('moves only the default pointer and touches no provider byte', async () => {
    const root = tmpRoot();
    seed(root, SEED_CONFIG, SEED_SECRETS);
    const before = readConfig(root);

    const result = await createHostLocalProviderManagementApi({ root }).setDefaultProvider('ollama');

    expect(result.activeProviderId).toBe('ollama');
    expect(result.activeModel).toBe('gpt-4o-mini');
    const after = readConfig(root);
    expect(after.slice(after.indexOf('[providers.ollama]'))).toBe(
      before.slice(before.indexOf('[providers.ollama]')),
    );
    expect(after).toContain('provider = "ollama"');
    expect(after).toContain('default = "gpt-4o-mini"');
  });

  it('accepts a null default meaning "no provider chosen"', async () => {
    const root = tmpRoot();
    seed(root, SEED_CONFIG, SEED_SECRETS);

    const result = await createHostLocalProviderManagementApi({ root }).setDefaultProvider(null);

    expect(result.activeProviderId).toBeUndefined();
    expect(readModel(root).provider).toBe('');
  });

  it('will not point the default at a provider that does not exist', async () => {
    const root = tmpRoot();
    seed(root, SEED_CONFIG, SEED_SECRETS);

    const error = await createHostLocalProviderManagementApi({ root })
      .setDefaultProvider('ghost')
      .catch((thrown: unknown) => thrown);

    expect((error as HostProviderApiError).status).toBe(404);
    expect(readModel(root).provider).toBe('openai');
  });
});

describe('provider probe', () => {
  it('answers with the remote ids and keeps the key in the request only', async () => {
    const root = tmpRoot();
    seed(root, SEED_CONFIG, SEED_SECRETS);
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const api = createHostLocalProviderManagementApi({
      root,
      fetchImpl: fakeFetch(
        () => ({ status: 200, body: { data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-5' }] } }),
        seen,
      ),
    });

    const result = await api.testProvider('openai');

    expect(result).toMatchObject({ ok: true, code: 'ok', truncated: false });
    expect(result.modelIds).toEqual(['gpt-4o-mini', 'gpt-5']);
    // The list path comes from the catalog row this provider resolves to, not
    // from an assumption that every endpoint is the OpenAI one.
    expect(seen[0]!.url).toBe('https://api.openai.com/v1/models');
    expect(seen[0]!.headers.Authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(JSON.stringify(result)).not.toContain(OPENAI_KEY);
  });

  it('uses the anthropic headers for that family and its own list path', async () => {
    const root = tmpRoot();
    seed(
      root,
      [
        '[providers.minimax-cn]',
        'id = "minimax-cn"',
        'name = "MiniMax CN"',
        'providerType = "anthropic"',
        'baseUrl = "https://api.minimaxi.com/anthropic"',
        '',
      ].join('\n'),
      { 'providers.minimax-cn.apiKey': 'anthropic-style-key-1234' },
    );
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const api = createHostLocalProviderManagementApi({
      root,
      fetchImpl: fakeFetch(() => ({ status: 200, body: { data: [{ id: 'MiniMax-M3' }] } }), seen),
    });

    const result = await api.testProvider('minimax-cn');

    expect(result.ok).toBe(true);
    expect(seen[0]!.headers['x-api-key']).toBe('anthropic-style-key-1234');
    expect(seen[0]!.headers.Authorization).toBeUndefined();
  });

  it('turns an HTTP refusal into a named code, not a stack', async () => {
    const root = tmpRoot();
    seed(root, SEED_CONFIG, SEED_SECRETS);
    const api = createHostLocalProviderManagementApi({
      root,
      fetchImpl: fakeFetch(() => ({ status: 401, body: {} })),
    });

    const result = await api.testProvider('openai');

    expect(result.ok).toBe(false);
    expect(result.code).toBe('auth');
    expect(result.message).toContain('HTTP 401');
  });

  it('strips a key that an upstream echoes back into its error', async () => {
    const root = tmpRoot();
    seed(root, SEED_CONFIG, SEED_SECRETS);
    const api = createHostLocalProviderManagementApi({
      root,
      fetchImpl: async () => {
        throw new Error(`upstream rejected Authorization: Bearer ${OPENAI_KEY}`);
      },
    });

    const result = await api.testProvider('openai');

    expect(result.code).toBe('network');
    expect(result.message ?? '').not.toContain(OPENAI_KEY);
    expect(result.message ?? '').toContain('[REDACTED]');
  });

  it('reports a provider with no endpoint instead of dialling nothing', async () => {
    const root = tmpRoot();
    seed(
      root,
      '[providers.local]\nid = "local"\nname = "Local"\nproviderType = "openai"\n',
      SEED_SECRETS,
    );

    const result = await createHostLocalProviderManagementApi({ root }).testProvider('local');

    expect(result).toMatchObject({ ok: false, code: 'no_base_url' });
  });

  it('reports a remote provider with no key instead of an unauthenticated call', async () => {
    const root = tmpRoot();
    seed(root, SEED_CONFIG);

    const result = await createHostLocalProviderManagementApi({
      root,
      fetchImpl: fakeFetch(() => ({ status: 200, body: { data: [{ id: 'x' }] } })),
    }).testProvider('openai');

    expect(result).toMatchObject({ ok: false, code: 'no_api_key' });
  });

  it('probes a local runtime without one, because it has none to give', async () => {
    const root = tmpRoot();
    seed(root, SEED_CONFIG);
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const api = createHostLocalProviderManagementApi({
      root,
      fetchImpl: fakeFetch(
        () => ({ status: 200, body: { models: [{ name: 'llama3.3:latest' }] } }),
        seen,
      ),
    });

    const result = await api.testProvider('ollama');

    // Ollama answers its own API, unsigned, and lists under `models`.
    expect(result).toMatchObject({ ok: true, code: 'ok' });
    expect(result.modelIds).toEqual(['llama3.3:latest']);
    expect(seen[0]!.url).toBe('http://127.0.0.1:11434/api/tags');
    expect(seen[0]!.headers.Authorization).toBeUndefined();
  });

  it('says so for a provider that authenticates from the environment', async () => {
    const root = tmpRoot();
    seed(
      root,
      '[providers.bedrock]\nid = "bedrock"\nname = "Bedrock"\nproviderType = "bedrock"\n' +
        'baseUrl = "https://bedrock-runtime.us-east-1.amazonaws.com"\n',
    );
    let dialed = 0;
    const api = createHostLocalProviderManagementApi({
      root,
      fetchImpl: fakeFetch(() => {
        dialed += 1;
        return { status: 200, body: { data: [] } };
      }),
    });

    const result = await api.testProvider('bedrock');

    expect(result).toMatchObject({ ok: false, code: 'not_testable' });
    expect(dialed).toBe(0);
  });

  it('drops an embedding row so the picker cannot offer a model that fails a turn', async () => {
    const root = tmpRoot();
    seed(root, SEED_CONFIG, SEED_SECRETS);
    const api = createHostLocalProviderManagementApi({
      root,
      fetchImpl: fakeFetch(() => ({
        status: 200,
        body: {
          data: [{ id: 'text-embedding-3', type: 'embedding' }, { id: 'gpt-4o-mini', type: 'llm' }],
        },
      })),
    });

    expect((await api.testProvider('openai')).modelIds).toEqual(['gpt-4o-mini']);
  });

  it('refuses to probe a provider that is not configured', async () => {
    const root = tmpRoot();
    seed(root, SEED_CONFIG, SEED_SECRETS);

    const error = await createHostLocalProviderManagementApi({ root })
      .testProvider('ghost')
      .catch((thrown: unknown) => thrown);

    expect((error as HostProviderApiError).status).toBe(404);
  });
});

describe('mutual exclusion', () => {
  it('keeps both of two providers saved at the same moment', async () => {
    const root = tmpRoot();
    seed(root, SEED_CONFIG, SEED_SECRETS);
    const api = createHostLocalProviderManagementApi({ root });

    const results = await Promise.all([
      api.upsertProvider({
        name: 'Vendor One',
        providerType: 'openai-compatible',
        baseUrl: 'https://one.example.com/v1',
        apiKey: 'sk-one-key-value',
      }),
      api.upsertProvider({
        name: 'Vendor Two',
        providerType: 'openai-compatible',
        baseUrl: 'https://two.example.com/v1',
        apiKey: 'sk-two-key-value',
      }),
    ]);

    const providers = readProviders(root);
    expect(results.map((row) => row.provider.providerId).sort()).toEqual(['vendor-one', 'vendor-two']);
    expect(Object.keys(providers).sort()).toEqual(
      ['ollama', 'openai', 'vendor-one', 'vendor-two'].sort(),
    );
    expect(readSecrets(root)).toMatchObject({
      'providers.openai.apiKey': OPENAI_KEY,
      'providers.vendor-one.apiKey': 'sk-one-key-value',
      'providers.vendor-two.apiKey': 'sk-two-key-value',
    });
  });
});

describe('candidate connection validation before persistence', () => {
  it.each(['reject', 'throw', 'accept'] as const)('preserves credentials on %s', async mode => {
    const root = tmpRoot();
    const initial = createHostLocalProviderManagementApi({ root });
    await initial.upsertProvider({ providerId: 'candidate', name: 'Candidate', providerType: 'openai-compatible', baseUrl: 'https://example.test/v1', models: ['m'], apiKey: 'old-working-key' });
    const beforeConfig = readConfig(root);
    const beforeSecrets = fs.readFileSync(secretsPath(root), 'utf8');
    const api = createHostLocalProviderManagementApi({ root, fetchImpl: async (_url, init) => {
      expect(init.headers.Authorization).toBe('Bearer new-key');
      if (mode === 'throw') throw new Error('offline');
      return { ok: mode === 'accept', status: mode === 'accept' ? 200 : 401, json: async () => ({ data: [{ id: 'm' }] }) };
    } });
    const operation = api.upsertProvider({ providerId: 'candidate', name: 'Candidate', providerType: 'openai-compatible', baseUrl: 'https://example.test/v1', models: ['m'], apiKey: 'new-key', validateConnection: true });
    if (mode === 'accept') {
      await operation;
      expect(JSON.stringify(readSecrets(root))).toContain('new-key');
    } else {
      await expect(operation).rejects.toMatchObject({ code: 'provider_probe_failed' });
      expect(readConfig(root)).toBe(beforeConfig);
      expect(fs.readFileSync(secretsPath(root), 'utf8')).toBe(beforeSecrets);
    }
  });

  it('refuses to overwrite an external edit made during validation', async () => {
    const root = tmpRoot();
    const api = createHostLocalProviderManagementApi({ root, fetchImpl: async () => {
      fs.writeFileSync(configPath(root), '# external edit\n');
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm' }] }) };
    } });
    await expect(api.upsertProvider({ providerId: 'new', name: 'New', providerType: 'openai-compatible', baseUrl: 'https://example.test/v1', models: ['m'], apiKey: 'new-key', validateConnection: true })).rejects.toMatchObject({ status: 409 });
    expect(readConfig(root)).toBe('# external edit\n');
    expect(readSecrets(root)).toEqual({});
  });
});
