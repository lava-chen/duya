/**
 * IPC e2e: app connections.
 *
 * This specifically guards the startup-order regression where the IPC handler
 * constructed AppConnectionService before SQLite initialization and every
 * renderer list request failed with a null database.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { launchDuya, closeDuya, invokeApi, type DuyaApp } from '../helpers';

let dua: DuyaApp;

/**
 * The builtin connector catalog, read from its single source of truth.
 *
 * The E2E runs in the `build` job, which compiles the Electron bundle from
 * workspace SOURCES (`workspacePublicSources`), so no package's `dist/` is
 * produced there and `@duya/connectors/app-connector-id` is not importable
 * here — its `exports` map points at `dist/`. The source file IS in the
 * checkout, so the list is read from it instead of being hardcoded: adding a
 * builtin provider then does not turn this spec red, while a provider that
 * the IPC surface stops serving still does.
 */
function builtinConnectorIds(): string[] {
  const sourcePath = path.resolve(
    __dirname,
    '..',
    '..',
    'packages',
    'connectors',
    'src',
    'app-connector-id.ts',
  );
  const source = fs.readFileSync(sourcePath, 'utf8');
  const match = /BUILTIN_CONNECTOR_IDS[^=]*=\s*\[([\s\S]*?)\]/.exec(source);
  if (!match) throw new Error(`BUILTIN_CONNECTOR_IDS not found in ${sourcePath}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

test.afterEach(async () => {
  if (dua) await closeDuya(dua.app);
});

test.describe('app connection IPC', () => {
  test('list and providers are available after the real Electron boot sequence', async () => {
    dua = await launchDuya({ namespace: 'ipc-app-connections' });

    const connections = await invokeApi<{ success: boolean; data?: unknown[]; error?: string }>(
      dua.page,
      'appConnection.list',
    );
    expect(connections.success, connections.error).toBe(true);
    expect(Array.isArray(connections.data)).toBe(true);

    const providers = await invokeApi<{
      success: boolean;
      data?: Array<{ id: string; configured: boolean; configurationHint?: string }>;
      error?: string;
    }>(dua.page, 'appConnection.providers');
    expect(providers.success, providers.error).toBe(true);
    expect(providers.data?.map((provider) => provider.id)).toEqual(builtinConnectorIds());
    expect(providers.data?.every((provider) => typeof provider.configured === 'boolean')).toBe(true);
  });
});
