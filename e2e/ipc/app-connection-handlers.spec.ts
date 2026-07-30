/**
 * IPC e2e: app connections.
 *
 * This specifically guards the startup-order regression where the IPC handler
 * constructed AppConnectionService before SQLite initialization and every
 * renderer list request failed with a null database.
 */
import { test, expect } from '@playwright/test';
import { launchDuya, closeDuya, invokeApi, type DuyaApp } from '../helpers';

let dua: DuyaApp;

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
    expect(providers.data?.map((provider) => provider.id)).toEqual([
      'google',
      'slack',
      'microsoft365',
      'figma',
      'supabase',
      'sentry',
      'vercel',
      'notion',
      'linear',
    ]);
    expect(providers.data?.every((provider) => typeof provider.configured === 'boolean')).toBe(true);
  });
});
