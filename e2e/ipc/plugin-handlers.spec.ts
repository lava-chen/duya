/**
 * IPC e2e: plugin-handlers
 *
 * Exercises the real ipcMain handlers for plugin catalog / registry / health /
 * capability index through the renderer's window.electronAPI surface.
 *
 * These are read-only channels that don't require network access or a
 * marketplace configuration — they return the current state of the local
 * plugin system, which starts empty in a fresh test namespace.
 *
 * Channels covered:
 *   plugin:catalog:list
 *   plugin:registry:list
 *   plugin:health:list
 *   plugin:capability-index
 *   plugin:installed:v2
 */
import { test, expect } from '@playwright/test';
import { launchDuya, closeDuya, invokeApi, type DuyaApp } from '../helpers';

let dua: DuyaApp;

test.afterEach(async () => {
  if (dua) await closeDuya(dua.app);
});

test.describe('plugin IPC (read-only)', () => {
  test('catalog.list returns a success envelope with data array', async () => {
    dua = await launchDuya({ namespace: 'ipc-plugin-catalog' });

    const result = await invokeApi<{ success: boolean; data: unknown[] }>(
      dua.page,
      'plugin.catalog.list',
    );
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
  });

  test('registry.list returns a success envelope with data array', async () => {
    dua = await launchDuya({ namespace: 'ipc-plugin-registry' });

    const result = await invokeApi<{ success: boolean; data: unknown[] }>(
      dua.page,
      'plugin.registry.list',
    );
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
  });

  test('health.list returns a success envelope with data array', async () => {
    dua = await launchDuya({ namespace: 'ipc-plugin-health' });

    const result = await invokeApi<{ success: boolean; data: unknown[] }>(
      dua.page,
      'plugin.health.list',
    );
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
  });

  test('capabilityIndex returns a success envelope with data array', async () => {
    dua = await launchDuya({ namespace: 'ipc-plugin-capability' });

    const result = await invokeApi<{ success: boolean; data: unknown[] }>(
      dua.page,
      'plugin.capabilityIndex',
    );
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
  });

  test('installedV2 returns a success envelope with data object', async () => {
    dua = await launchDuya({ namespace: 'ipc-plugin-installed' });

    const result = await invokeApi<{ success: boolean; data: Record<string, unknown> }>(
      dua.page,
      'plugin.installedV2',
    );
    expect(result.success).toBe(true);
    expect(typeof result.data).toBe('object');
    expect(result.data).not.toBeNull();
  });
});
