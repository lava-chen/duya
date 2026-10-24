import { expect, test, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeDuya, invokeApi, launchDuya, showWorkTab, userDataRootFor, type DuyaApp } from '../helpers';
import { startLoopbackAnthropic, type LoopbackAnthropic } from '../turn/loopback-anthropic';

let app: DuyaApp;
let namespace = '';
let pluginParent = '';
let pluginPath: string;
let provider: LoopbackAnthropic | undefined;

async function dismissOnboardingIfVisible(page: Page): Promise<void> {
  const skip = page.getByRole('button', { name: 'Skip', exact: true });
  const shown = await skip.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false);
  if (!shown) return;
  await skip.click();
  await expect(skip).toBeHidden({ timeout: 5_000 });
}

test.afterEach(async () => {
  await provider?.close();
  provider = undefined;
  if (app) {
    await closeDuya(app.app);
    app = undefined as unknown as DuyaApp;
  }
  if (namespace) {
    fs.rmSync(userDataRootFor(namespace), { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    namespace = '';
  }
  if (pluginParent) {
    fs.rmSync(pluginParent, { recursive: true, force: true });
    pluginParent = '';
    pluginPath = '';
  }
});

test('installed MCP surface appears in Apps and loads its resource in the panel', async () => {
  pluginParent = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-report-viewer-e2e-'));
  pluginPath = path.join(pluginParent, 'package');
  fs.cpSync(path.resolve(process.cwd(), 'plugins/examples/report-viewer'), pluginPath, { recursive: true });

  // Keep the shipped example session-scoped. The product-path fixture uses
  // `always` so the real Apps launcher can open without configuring a model.
  const manifestPath = path.join(pluginPath, '.duya-plugin', 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    extensions: { 'com.duya.client': { apps: Array<{ ui: { surfaces: Array<{ availability: string }> } }> } };
  };
  manifest.extensions['com.duya.client'].apps[0].ui.surfaces[0].availability = 'always';
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  namespace = `plugin-ui-resource-surface-${process.pid}-${Date.now()}`;
  app = await launchDuya({ namespace });
  const installed = await invokeApi<{ success: boolean; error?: string }>(
    app.page,
    'plugin.installLocal',
    { pluginPath, scope: 'user' },
  );
  expect(installed.success, installed.error).toBe(true);

  const directory = await invokeApi<{
    success: boolean;
    data: { surfaces: Array<{ id: string; pluginId: string; resourceUri: string }> };
  }>(app.page, 'plugin.uiSurfaces.list');
  expect(directory.success).toBe(true);
  expect(directory.data.surfaces).toContainEqual(expect.objectContaining({
    id: 'report-overview',
    pluginId: 'com.duya.examples.report-viewer',
    resourceUri: 'ui://reports/overview',
  }));

  await dismissOnboardingIfVisible(app.page);
  await showWorkTab(app.page);
  await app.page.getByRole('button', { name: 'Apps', exact: true }).click();
  await expect(app.page.getByRole('heading', { name: 'Mini Apps', exact: true })).toBeVisible();
  await expect(app.page.getByRole('heading', { name: 'Report Viewer', exact: true })).toBeVisible();
  const launchSurface = app.page.getByRole('button', { name: 'Report overview', exact: true });
  await expect(launchSurface).toBeVisible();
  await launchSurface.click();

  const iframe = app.page.locator('iframe[title="Report overview"]');
  await expect(iframe).toBeVisible({ timeout: 30_000 });
  const frame = app.page.frameLocator('iframe[title="Report overview"]');
  await expect(frame.getByRole('heading', { name: 'Report overview', exact: true })).toBeVisible();
  await expect(frame.getByText('This read-only page is loaded from the plugin\'s MCP resource.')).toBeVisible();
  await expect(frame.locator('tbody tr')).toHaveCount(3);

  const entryUrl = new URL((await iframe.getAttribute('src'))!);
  expect(entryUrl.hostname).toBe('127.0.0.1');
  expect(entryUrl.pathname).toMatch(/^\/[^/]+\/index\.html$/);

  await launchSurface.click();
  await expect(iframe).toHaveCount(1);
});

test('a real desktop agent worker sends select and highlight to its open surface', async () => {
  test.setTimeout(180_000);
  provider = await startLoopbackAnthropic({
    text: 'The requested records are selected and highlighted.',
    model: 'claude-plugin-ui-events-e2e',
    toolCalls: [
      {
        nameIncludes: '6b785c',
        input: { surfaceId: 'report-overview', payload: { recordId: 'report-17' } },
      },
      {
        nameIncludes: '81f085',
        input: { surfaceId: 'report-overview', payload: { recordId: 'report-23' } },
      },
    ],
  });

  pluginParent = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-report-viewer-worker-e2e-'));
  pluginPath = path.join(pluginParent, 'package');
  fs.cpSync(path.resolve(process.cwd(), 'plugins/examples/report-viewer'), pluginPath, { recursive: true });
  const manifestPath = path.join(pluginPath, '.duya-plugin', 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    extensions: { 'com.duya.client': { apps: Array<{ ui: { surfaces: Array<{ availability: string }> } }> } };
  };
  manifest.extensions['com.duya.client'].apps[0].ui.surfaces[0].availability = 'session';
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  namespace = `plugin-ui-worker-events-${process.pid}-${Date.now()}`;
  app = await launchDuya({ namespace });
  const installed = await invokeApi<{ success: boolean; error?: string }>(
    app.page,
    'plugin.installLocal',
    { pluginPath, scope: 'user' },
  );
  expect(installed.success, installed.error).toBe(true);
  const providerId = `plugin-ui-event-provider-${process.pid}`;
  await invokeApi(app.page, 'provider.upsert', {
    id: providerId,
    name: 'Plugin UI event E2E',
    providerType: 'anthropic',
    baseUrl: provider.baseUrl,
    apiKey: 'loopback-test-key',
    options: { defaultModel: 'claude-plugin-ui-events-e2e', enabled_models: ['claude-plugin-ui-events-e2e'] },
  });
  const activatedProvider = await invokeApi<{ id: string }>(app.page, 'provider.activate', providerId);
  expect(activatedProvider.id).toBe(providerId);
  const activeConfig = await invokeApi<{ baseUrl?: string } | null>(app.page, 'provider.getActiveProviderConfig');
  expect(activeConfig?.baseUrl).toBe(provider.baseUrl);

  await dismissOnboardingIfVisible(app.page);
  await showWorkTab(app.page);
  await app.page.locator('.sidebar-new-chat-btn').click();
  await app.page.locator('.welcome-project-dropdown-trigger').last().click();
  const newNoProjectSession = app.page.getByLabel('Dropdown menu').getByRole('button', {
    name: /New No-Project Chat|新建无项目会话/,
  });
  await expect(newNoProjectSession).toBeVisible();
  await newNoProjectSession.click();

  const activeThread = app.page.locator('.thread-item.active');
  await expect(activeThread).toBeVisible({ timeout: 20_000 });
  await app.page.getByRole('button', { name: 'Apps', exact: true }).click();
  const launchSurface = app.page.getByRole('button', { name: 'Report overview', exact: true });
  await expect(launchSurface).toBeVisible();
  await launchSurface.click();

  const iframe = app.page.locator('iframe[title="Report overview"]');
  await expect(iframe).toBeVisible({ timeout: 30_000 });
  const frame = app.page.frameLocator('iframe[title="Report overview"]');
  await expect(frame.locator('tbody tr')).toHaveCount(3);

  await activeThread.click();
  // Plugin MCP tools need approval in Auto mode; keep this isolated test turn
  // on Full access so the real worker can execute the two read-only UI events.
  await app.page.getByRole('button', { name: 'Auto', exact: true }).click();
  await expect(app.page.getByRole('button', { name: 'Full access', exact: true })).toBeVisible();
  const composer = app.page.locator('[contenteditable="true"][role="textbox"]').last();
  await composer.fill('@com.duya.examples.report-viewer select report-17 and highlight report-23');
  await app.page.getByRole('button', { name: 'Send', exact: true }).click();

  await expect.poll(() => provider?.requests.length ?? 0, { timeout: 60_000 }).toBeGreaterThan(0);
  expect(provider?.toolCallsSent, JSON.stringify(provider?.requests, null, 2)).toHaveLength(2);
  await expect(frame.locator('[data-record-id="report-17"]')).toHaveClass(/is-selected/, { timeout: 30_000 });
  await expect(frame.locator('[data-record-id="report-23"]')).toHaveClass(/is-highlighted/, { timeout: 30_000 });
  expect(provider.requests[0]?.toolNames).toContain(provider.toolCallsSent[0]?.name);
  expect(provider.toolCallsSent.map((call) => call.input.surfaceId)).toEqual([
    'report-overview',
    'report-overview',
  ]);
});
