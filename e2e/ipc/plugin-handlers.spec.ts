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
 */
import { test, expect } from '@playwright/test';
import { launchDuya, closeDuya, invokeApi, type DuyaApp } from '../helpers';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

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
});

test('Desktop install and standalone CLI share plugin configuration and management', async ({}, testInfo) => {
  const namespace = 'ipc-plugin-shared-service';
  const source = testInfo.outputPath('fixture-plugin');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'plugin.json'), JSON.stringify({
    schemaVersion: 'duya.plugin.v2', id: 'com.duya.ipc-shared', name: 'Shared service fixture', version: '1.0.0',
    description: 'IPC/CLI consistency fixture', author: { name: 'Fixture' }, capabilities: {}, permissions: [], engines: { duya: '>=0.1.0' },
  }));
  dua = await launchDuya({ namespace, previewMode: true });
  const install = await invokeApi<{ success: boolean }>(dua.page, 'plugin.installLocal', { pluginPath: source });
  expect(install.success).toBe(true);
  const run = async (args: string[]) => {
    const result = await promisify(execFile)(process.execPath, [path.resolve('packages/cli/bundle/cli.cjs'), 'plugin', ...args, '--format', 'json'], {
      cwd: path.resolve('.'), timeout: 30_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, DUYA_TEST: '1', DUYA_TEST_NAMESPACE: namespace },
    });
    return JSON.parse(result.stdout);
  };
  expect((await run(['list'])).plugins).toContainEqual(expect.objectContaining({ id: 'com.duya.ipc-shared', version: '1.0.0', enabled: true }));
  await run(['disable', 'com.duya.ipc-shared', '--yes']);
  const registry = await invokeApi<{ success: boolean; data: { id: string; enabled: boolean }[] }>(dua.page, 'plugin.registry.list');
  expect(registry.success).toBe(true);
  expect(registry.data).toContainEqual(expect.objectContaining({ id: 'com.duya.ipc-shared', enabled: false }));
  await run(['uninstall', 'com.duya.ipc-shared', '--yes']);
  const after = await invokeApi<{ data: { id: string }[] }>(dua.page, 'plugin.registry.list');
  expect(after.data.some(plugin => plugin.id === 'com.duya.ipc-shared')).toBe(false);
});
