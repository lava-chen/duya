/**
 * The provider management routes (plan 632).
 *
 * ## What these assertions exist for
 *
 * These are the first Host routes that let a client change the configuration
 * the worker runs from, so the two things they must never do are answer as if
 * the credential were ordinary data, and answer with a status that misreports
 * the failure.
 *
 * The route is OPTIONAL: a Host composed without a writable configuration
 * answers 404 `provider_management_api_unavailable`, which is "this Host cannot
 * do that" and not "the write failed" — the same distinction the `/init` route
 * documents, and the reason the write API is a separate option from the
 * read-only catalog.
 *
 * The cases below drive the real API against the real files in a temp root
 * rather than a stub, because the point of these routes is that a byte lands on
 * disk.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from '@iarna/toml';
import type { HostProviderWriteInput } from '@duya/agent-protocol/provider-catalog';
import { createHostLocalProviderManagementApi } from '../src/provider-management/index.js';
import { HostSessionHttpClient } from '../src/http-client.js';
import { HostSessionHttpServer, type HostSessionHttpServerOptions } from '../src/http-server.js';

const TOKEN = 'test-token';
const SECRET = 'sk-http-side-secret-value';

const CONFIG = [
  '[model]',
  'default = "gpt-4o-mini"',
  'provider = "openai"',
  '',
  '[providers.openai]',
  'id = "openai"',
  'name = "OpenAI"',
  'providerType = "openai"',
  'baseUrl = "https://api.openai.com/v1"',
  '',
  '  [providers.openai.options]',
  '  enabled_models = [ "gpt-4o-mini" ]',
  '',
].join('\n');

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'duya-provider-http-'));
}

function configOf(root: string): string {
  return fs.readFileSync(path.join(root, 'config.toml'), 'utf8');
}

function secretsOf(root: string): Record<string, unknown> {
  const file = path.join(root, 'secrets.json');
  return fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>)
    : {};
}

/** A server whose provider API writes into a throwaway config root. */
async function startProviderServer(root: string): Promise<{ origin: string; client: HostSessionHttpClient }> {
  const server = new HostSessionHttpServer({
    api: {} as HostSessionHttpServerOptions['api'],
    taskApi: {} as HostSessionHttpServerOptions['taskApi'],
    token: TOKEN,
    localProviderManagementApi: createHostLocalProviderManagementApi({
      root,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'gpt-5' }] }),
      }),
    }),
  });
  await server.listen();
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;
  return { origin, client: new HostSessionHttpClient(origin, TOKEN) };
}

/** A server with no provider API at all. */
async function startBareServer(): Promise<string> {
  const server = new HostSessionHttpServer({
    api: {} as HostSessionHttpServerOptions['api'],
    taskApi: {} as HostSessionHttpServerOptions['taskApi'],
    token: TOKEN,
  });
  await server.listen();
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

const servers: HostSessionHttpServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

describe('the Host provider routes', () => {
  it('refuses by name when this Host has no writable configuration', async () => {
    const origin = await startBareServer();

    const response = await fetch(`${origin}/v1/local/providers`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 'provider_management_api_unavailable' } });
  });

  it('refuses a write the same way, rather than accepting one it would drop', async () => {
    const origin = await startBareServer();

    const response = await fetch(`${origin}/v1/local/providers/upsert`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ghost', providerType: 'openai' }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 'provider_management_api_unavailable' } });
  });

  it('lists what the files say, with the key reduced to a mask', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'config.toml'), CONFIG, 'utf8');
    fs.writeFileSync(
      path.join(root, 'secrets.json'),
      JSON.stringify({ 'providers.openai.apiKey': SECRET }),
      'utf8',
    );
    const { origin, client } = await startProviderServer(root);

    const raw = await (await fetch(`${origin}/v1/local/providers`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })).text();
    const list = await client.listProviders();

    expect(raw).not.toContain(SECRET);
    expect(list.activeProviderId).toBe('openai');
    expect(list.providers).toHaveLength(1);
    expect(list.providers[0]).toMatchObject({
      providerId: 'openai',
      models: ['gpt-4o-mini'],
      hasApiKey: true,
      isDefault: true,
    });
    expect(list.providers[0]!.maskedApiKey).toContain('***');
    expect(list.revision).not.toBe('');
  });

  it('writes a provider through the client and changes the file', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'config.toml'), CONFIG, 'utf8');
    const { client } = await startProviderServer(root);

    const result = await client.upsertProvider({
      providerId: 'deepseek',
      name: 'DeepSeek',
      providerType: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      models: ['deepseek-chat'],
      apiKey: 'sk-deepseek-abcdefghij',
    } satisfies HostProviderWriteInput);

    expect(result.provider).toMatchObject({ providerId: 'deepseek', hasApiKey: true });
    expect(result.revision).not.toBe('');
    const doc = parse(configOf(root)) as { providers: Record<string, Record<string, unknown>> };
    expect(doc.providers.deepseek).toMatchObject({ name: 'DeepSeek' });
    expect(doc.providers.openai).toMatchObject({ name: 'OpenAI' });
    expect(secretsOf(root)['providers.deepseek.apiKey']).toBe('sk-deepseek-abcdefghij');
  });

  it('never lets a key cross the wire on the way back', async () => {
    const root = tmpRoot();
    const { origin, client } = await startProviderServer(root);

    const responses: string[] = [];
    const raw = await (
      await fetch(`${origin}/v1/local/providers/upsert`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          providerId: 'anthropic',
          name: 'Anthropic',
          providerType: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
          apiKey: SECRET,
        }),
      })
    ).text();
    responses.push(raw);
    responses.push(JSON.stringify(await client.listProviders()));

    for (const body of responses) expect(body).not.toContain(SECRET);
    expect(secretsOf(root)['providers.anthropic.apiKey']).toBe(SECRET);
  });

  it('deletes a provider and its stored key', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'config.toml'), CONFIG, 'utf8');
    fs.writeFileSync(
      path.join(root, 'secrets.json'),
      JSON.stringify({ 'providers.openai.apiKey': SECRET }),
      'utf8',
    );
    const { client } = await startProviderServer(root);

    const result = await client.deleteProvider('openai');

    expect(result).toMatchObject({ providerId: 'openai', clearedDefault: true });
    expect(configOf(root)).not.toContain('[providers.openai]');
    expect(secretsOf(root)).not.toHaveProperty('providers.openai.apiKey');
  });

  it('moves the default without touching the model choice', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'config.toml'), CONFIG, 'utf8');
    const { client } = await startProviderServer(root);

    await client.upsertProvider({
      providerId: 'ollama',
      name: 'Ollama',
      providerType: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
    });
    const result = await client.setDefaultProvider('ollama');

    expect(result.activeProviderId).toBe('ollama');
    expect(result.activeModel).toBe('gpt-4o-mini');
  });

  it('tests a provider without ever sending its key to the client', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'config.toml'), CONFIG, 'utf8');
    fs.writeFileSync(
      path.join(root, 'secrets.json'),
      JSON.stringify({ 'providers.openai.apiKey': SECRET }),
      'utf8',
    );
    const { client } = await startProviderServer(root);

    const result = await client.testProvider('openai');

    expect(result).toMatchObject({ ok: true, code: 'ok' });
    expect(result.modelIds).toEqual(['gpt-5']);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('answers a failed probe as a 200 with a reason', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'config.toml'), CONFIG, 'utf8');
    fs.writeFileSync(
      path.join(root, 'secrets.json'),
      JSON.stringify({ 'providers.openai.apiKey': SECRET }),
      'utf8',
    );
    const server = new HostSessionHttpServer({
      api: {} as HostSessionHttpServerOptions['api'],
      taskApi: {} as HostSessionHttpServerOptions['taskApi'],
      token: TOKEN,
      localProviderManagementApi: createHostLocalProviderManagementApi({
        root,
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    });
    await server.listen();
    servers.push(server);
    const origin = `http://127.0.0.1:${server.port}`;
    const client = new HostSessionHttpClient(origin, TOKEN);

    const response = await fetch(`${origin}/v1/local/providers/test`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'openai' }),
    });

    // A dead endpoint is an answer about the provider, not a Host that broke.
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false, code: 'network' });
    expect((await client.testProvider('openai')).message).toContain('ECONNREFUSED');
  });

  it('carries a refusal back as the status and code the API chose', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'config.toml'), CONFIG, 'utf8');
    const { origin, client } = await startProviderServer(root);

    const response = await fetch(`${origin}/v1/local/providers/delete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'nobody' }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'provider_not_found' } });

    const error = await client.deleteProvider('nobody').catch((thrown: unknown) => thrown);
    expect((error as { status: number; code: string }).status).toBe(404);
    expect((error as { code: string }).code).toBe('provider_not_found');
  });

  it('refuses a masked key with its own code, not a generic bad request', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'config.toml'), CONFIG, 'utf8');
    const { client } = await startProviderServer(root);

    const error = await client
      .upsertProvider({
        providerId: 'openai',
        name: 'OpenAI',
        providerType: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-r***ghij',
      })
      .catch((thrown: unknown) => thrown);

    expect((error as { status: number; code: string }).status).toBe(400);
    expect((error as { code: string }).code).toBe('masked_api_key');
  });

  it('refuses a stale write with a 409 the panel can act on', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'config.toml'), CONFIG, 'utf8');
    const { client } = await startProviderServer(root);

    const stale = (await client.listProviders()).revision;
    fs.appendFileSync(
      path.join(root, 'config.toml'),
      '[providers.hand]\nid = "hand"\nname = "Hand"\nproviderType = "openai"\n' +
        'baseUrl = "https://hand.example.com/v1"\n',
      'utf8',
    );

    const error = await client
      .upsertProvider(
        { name: 'Late', providerType: 'openai', baseUrl: 'https://late.example.com/v1' },
      )
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    // The id is allocated from the name, so this write would not collide — and
    // the guard still refuses it, because the caller said which file it saw.
    const conflict = await client
      .upsertProvider(
        {
          providerId: 'openai',
          name: 'OpenAI',
          providerType: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          expectedRevision: stale,
        },
      )
      .catch((thrown: unknown) => thrown);

    expect(error).toBeUndefined();
    expect((conflict as { status: number; code: string }).status).toBe(409);
    expect((conflict as { code: string }).code).toBe('provider_revision_conflict');
  });

  it('rejects a body that names no provider instead of guessing', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'config.toml'), CONFIG, 'utf8');
    const { origin } = await startProviderServer(root);

    for (const route of ['/v1/local/providers/delete', '/v1/local/providers/test']) {
      const response = await fetch(`${origin}${route}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: '' }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: 'invalid_provider_id' } });
    }
  });

  it('rejects a revision that is not a string rather than dropping the guard', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'config.toml'), CONFIG, 'utf8');
    const { origin } = await startProviderServer(root);

    const response = await fetch(`${origin}/v1/local/providers/set-default`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'openai', expectedRevision: 7 }),
    });

    // A guard quietly thrown away by a type error is a lost update.
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: 'invalid_provider_revision' } });
  });

  it('rejects a set-default body that names neither a provider nor null', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'config.toml'), CONFIG, 'utf8');
    const { origin } = await startProviderServer(root);

    const response = await fetch(`${origin}/v1/local/providers/set-default`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: 'invalid_provider_id' } });
  });

  it('answers an empty name with the field that was wrong', async () => {
    const root = tmpRoot();
    const { client } = await startProviderServer(root);

    const error = await client
      .upsertProvider({ name: '  ', providerType: 'openai' })
      .catch((thrown: unknown) => thrown);

    expect((error as { status: number; code: string }).status).toBe(400);
    expect((error as { code: string }).code).toBe('invalid_provider');
    expect((error as { message: string }).message).toContain('name is required');
  });
});

it('carries candidate validation over HTTP and preserves the old key on refusal', async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'config.toml'), CONFIG);
  fs.writeFileSync(path.join(root, 'secrets.json'), JSON.stringify({ 'providers.openai.apiKey': SECRET }));
  const beforeConfig = configOf(root);
  const beforeSecrets = fs.readFileSync(path.join(root, 'secrets.json'), 'utf8');
  const { client } = await startProviderServer(root);
  await expect(client.upsertProvider({ providerId: 'openai', name: 'OpenAI', providerType: 'openai-compatible', baseUrl: 'https://example.test/v1', models: ['m'], apiKey: '', validateConnection: true })).rejects.toThrow();
  expect(configOf(root)).toBe(beforeConfig);
  expect(fs.readFileSync(path.join(root, 'secrets.json'), 'utf8')).toBe(beforeSecrets);
});
