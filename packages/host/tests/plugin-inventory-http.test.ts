/**
 * The plugin inventory route.
 *
 * ## What these assertions exist for
 *
 * The route is an OPTIONAL capability, and the difference between "this Host
 * cannot answer" and "the answer is empty" is the whole point: a Host
 * without the plugin registry refuses `GET /v1/local/plugins` with 404
 * `plugin_inventory_api_unavailable`. An empty list would claim the machine
 * has no plugins, which is a different claim entirely.
 *
 * The route also has a security boundary to pin: the Host's own registry
 * entry carries the plugin manifest, and a manifest's MCP servers can
 * declare an `env`, `headers`, `command`, `args` or `url`. None of that may
 * reach a client that only wants to list plugins.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HostSessionHttpClient, HostSessionHttpError } from '../src/http-client.js';
import { HostSessionHttpServer, type HostSessionHttpServerOptions } from '../src/http-server.js';
import { createHostLocalPluginInventoryApi } from '../src/local-plugin-inventory-api.js';

const TOKEN = 'test-token';

/** A throwaway config root holding a `config.toml` with one enabled plugin. */
function configRootWithInstalledPlugin(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-host-plugin-inventory-'));
  fs.writeFileSync(
    path.join(root, 'config.toml'),
    ['[plugins."com.duya.documents@official"]', 'enabled = true', ''].join('\n'),
    'utf8',
  );
  const installed = path.join(root, 'plugins', 'installed', 'com.duya.documents');
  fs.mkdirSync(path.join(installed, 'mcp'), { recursive: true });
  fs.writeFileSync(
    path.join(installed, 'mcp', 'servers.json'),
    JSON.stringify({
      servers: [
        {
          name: 'documents',
          command: 'documents-mcp',
          args: ['--stdio'],
          env: { DOCUMENTS_TOKEN: 'super-secret' },
          url: 'https://documents.example',
          headers: { Authorization: 'Bearer super-secret' },
        },
      ],
    }),
    'utf8',
  );
  // The manifest facts a client may see: a description, and the app
  // connector ids the plugin declares. The credential-shaped manifest
  // fields stay out of the projection by construction; the fixture carries
  // the declarations so the boundary test can prove it.
  fs.mkdirSync(path.join(installed, '.duya-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(installed, '.duya-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'com.duya.documents',
      version: '1.0.0',
      description: 'Document workflows for the duya suite',
      components: {
        appConnections: ['slack', 'google'],
        mcpServers: ['documents'],
      },
    }),
    'utf8',
  );
  fs.mkdirSync(path.join(installed, 'skills', 'doc-review'), { recursive: true });
  fs.writeFileSync(path.join(installed, 'skills', 'doc-review', 'SKILL.md'), '---\nname: doc-review\n---\n', 'utf8');
  fs.mkdirSync(path.join(root, 'plugins-data', 'com.duya.documents'), { recursive: true });
  return root;
}

/** A server with only the capabilities a case needs. */
async function startServer(
  overrides: Partial<HostSessionHttpServerOptions>,
): Promise<{ server: HostSessionHttpServer; origin: string }> {
  const server = new HostSessionHttpServer({
    api: {} as HostSessionHttpServerOptions['api'],
    taskApi: {} as HostSessionHttpServerOptions['taskApi'],
    token: TOKEN,
    ...overrides,
  });
  await server.listen();
  return { server, origin: `http://127.0.0.1:${server.port}` };
}

describe('the Host plugin inventory route', () => {
  const opened: HostSessionHttpServer[] = [];

  afterEach(async () => {
    for (const server of opened.splice(0)) await server.close();
  });

  it('refuses with a named code when the Host has no plugin registry', async () => {
    const { server, origin } = await startServer({});
    opened.push(server);

    const response = await fetch(`${origin}/v1/local/plugins`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 'plugin_inventory_api_unavailable' } });
  });

  it('answers with the inventory the Host observed', async () => {
    const root = configRootWithInstalledPlugin();
    try {
      const { server, origin } = await startServer({
        localPluginInventoryApi: createHostLocalPluginInventoryApi(root),
      });
      opened.push(server);

      const response = await fetch(`${origin}/v1/local/plugins`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        plugins: [
          {
            id: 'com.duya.documents',
            name: 'com.duya.documents',
            enabled: true,
            marketplace: 'official',
            installed: true,
            hasDataPath: true,
            description: 'Document workflows for the duya suite',
            appConnections: ['slack', 'google'],
            mcpServers: ['documents'],
            skillNames: ['doc-review'],
          },
        ],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the plugin manifest and its credentials off the wire', async () => {
    const root = configRootWithInstalledPlugin();
    try {
      const { server, origin } = await startServer({
        localPluginInventoryApi: createHostLocalPluginInventoryApi(root),
      });
      opened.push(server);

      const response = await fetch(`${origin}/v1/local/plugins`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const body = (await response.json()) as {
        plugins: Array<Record<string, unknown>>;
      };

      // The component summaries are NAMES; the declarations behind them —
      // the manifest itself, the install and data paths, and every
      // credential-shaped MCP field — never appear, at any depth.
      const flattened = JSON.stringify(body);
      for (const secret of [
        'super-secret',
        'documents-mcp',
        '--stdio',
        'https://documents.example',
        'Bearer',
        'installPath',
        'dataPath',
        'manifest',
        'env',
        'headers',
        'command',
        'args',
        'url',
      ]) {
        expect(flattened).not.toContain(secret);
      }
      const plugin = body.plugins[0];
      expect(plugin).toMatchObject({
        description: 'Document workflows for the duya suite',
        appConnections: ['slack', 'google'],
        mcpServers: ['documents'],
        skillNames: ['doc-review'],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a plugin with no package directory as not installed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-host-plugin-inventory-'));
    try {
      fs.writeFileSync(
        path.join(root, 'config.toml'),
        ['[plugins."com.duya.documents@official"]', 'enabled = true', ''].join('\n'),
        'utf8',
      );
      const { server, origin } = await startServer({
        localPluginInventoryApi: createHostLocalPluginInventoryApi(root),
      });
      opened.push(server);

      const client = new HostSessionHttpClient(origin, TOKEN);

      expect(await client.listPlugins()).toEqual({
        plugins: [
          {
            id: 'com.duya.documents',
            name: 'com.duya.documents',
            enabled: true,
            marketplace: 'official',
            installed: false,
            hasDataPath: false,
          },
        ],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('surfaces the refusal code to a client that asks for the inventory', async () => {
    const { server, origin } = await startServer({});
    opened.push(server);

    const client = new HostSessionHttpClient(origin, TOKEN);

    await expect(client.listPlugins()).rejects.toMatchObject({
      status: 404,
      code: 'plugin_inventory_api_unavailable',
    });
    await expect(client.listPlugins()).rejects.toBeInstanceOf(HostSessionHttpError);
  });
});
