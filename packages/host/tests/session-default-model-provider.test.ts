/**
 * A session created without a provider/model must record the ones config.toml
 * actually selects.
 *
 * The row defaults are placeholders — `model` is `''` and `provider_id` is the
 * literal `'env'` — and those are exactly what a client renders. A CLI status
 * bar reading `env · default` while config.toml names a real provider is the
 * failure this covers.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { startLocalHost, type LocalHostHandle } from '../src/local-host.js';
import { HostSessionHttpClient } from '../src/http-client.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/** A data root with one provider and an optional global selection. */
async function createRoot(providerId: string, model: string, selectProvider = true): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-session-model-'));
  roots.push(root);
  await fs.writeFile(
    path.join(root, 'config.toml'),
    (selectProvider ? `[model]\nprovider = "${providerId}"\ndefault = "${model}"\n\n` : '') +
      `[providers.${providerId}]\nproviderType = "anthropic"\n` +
      `baseUrl = "https://example.invalid"\n\n` +
      `[providers.${providerId}.options]\nenabled_models = [ "${model}" ]\ndefaultModel = "${model}"\n`,
    'utf-8',
  );
  await fs.writeFile(
    path.join(root, 'secrets.json'),
    JSON.stringify({ [`providers.${providerId}.apiKey`]: 'test-key' }),
    'utf-8',
  );
  return root;
}

async function withHost<T>(
  dataRoot: string,
  body: (client: HostSessionHttpClient) => Promise<T>,
): Promise<T> {
  let host: LocalHostHandle | undefined;
  try {
    host = await startLocalHost({
      dataRoot,
      rolloutRoot: path.join(dataRoot, 'sessions'),
      attachmentsRoot: path.join(dataRoot, 'attachments'),
      runtimeFilePath: path.join(dataRoot, 'runtime', 'host-api.json'),
      port: 0,
      token: 'session-model-test-token',
    });
    return await body(new HostSessionHttpClient(host.origin, 'session-model-test-token'));
  } finally {
    await host?.close();
  }
}

describe('session provider/model defaults', () => {
  it('records the configured provider and model when the caller omits both', async () => {
    const dataRoot = await createRoot('minimax-cn', 'claude-sonnet-4');
    const session = await withHost(dataRoot, (client) =>
      client.create({ title: 'duya chat', mode: 'code' }),
    );

    expect(session.providerId).toBe('minimax-cn');
    expect(session.model).toBe('claude-sonnet-4');
  }, 30_000);

  it('uses a sole configured provider when no global provider is selected', async () => {
    const dataRoot = await createRoot('minimax-cn', 'MiniMax-M3', false);
    const session = await withHost(dataRoot, (client) =>
      client.create({ title: 'duya chat', mode: 'code' }),
    );

    expect(session.providerId).toBe('minimax-cn');
    expect(session.model).toBe('MiniMax-M3');
  }, 30_000);

  it('backfills legacy env/default placeholders when the session is resumed', async () => {
    const dataRoot = await createRoot('minimax-cn', 'MiniMax-M3', false);
    const session = await withHost(dataRoot, async (client) => {
      const placeholder = await client.create({
        title: 'old session',
        mode: 'code',
        model: '',
        providerId: 'env',
      });
      return client.create({ id: placeholder.id });
    });

    expect(session.providerId).toBe('minimax-cn');
    expect(session.model).toBe('MiniMax-M3');
  }, 30_000);

  it('keeps an explicitly requested model even when the configured one differs', async () => {
    const dataRoot = await createRoot('minimax-cn', 'claude-sonnet-4');
    const session = await withHost(dataRoot, (client) =>
      client.create({ title: 'duya chat', mode: 'code', model: 'pinned-model' }),
    );

    expect(session.model).toBe('pinned-model');
    // The half the caller DID leave unset still comes from config.
    expect(session.providerId).toBe('minimax-cn');
  }, 30_000);

  it('falls back to the schema placeholders when there is no config at all', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-session-noconfig-'));
    roots.push(dataRoot);

    const session = await withHost(dataRoot, (client) =>
      client.create({ title: 'duya chat', mode: 'code' }),
    );

    // Nothing resolved: the row keeps its own defaults rather than inventing a
    // provider. These are the literals the placeholder report is about.
    expect(session.providerId).toBe('env');
    expect(session.model).toBe('');
  }, 30_000);
});
