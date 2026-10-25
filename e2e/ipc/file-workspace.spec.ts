import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeDuya, invokeApi, launchDuya, type DuyaApp } from '../helpers';

let app: DuyaApp;
let projectDir: string;

test.afterEach(async () => {
  if (app) {
    await closeDuya(app.app);
    app = undefined as unknown as DuyaApp;
  }
  if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true });
});

test('expanded side panel keeps the floating composer and integrated project tree', async () => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-workspace-e2e-'));
  const filePath = path.join(projectDir, 'preview.md');
  fs.writeFileSync(filePath, '# Preview workspace\n\nRead-only project file preview.', 'utf8');

  app = await launchDuya({ namespace: 'file-workspace-ui', previewMode: true });
  const threadId = 'workspace-e2e-thread';
  await invokeApi(app.page, 'thread.create', {
    id: threadId,
    title: 'Workspace preview',
    working_directory: projectDir,
    project_name: path.basename(projectDir),
  });

  await app.page.evaluate(() => {
    window.localStorage.setItem('duya-onboarding-completed', 'true');
  });

  // Seed localStorage from an init script rather than from the live page: the
  // page being reloaded flushes its own panel state on `pagehide`, and that
  // flush would overwrite a value written just before the reload.
  await app.page.addInitScript(({ threadId, projectDir, filePath }) => {
    window.localStorage.setItem('duya-conversations', JSON.stringify({
      state: {
        currentView: 'chat',
        settingsTab: 'general',
        activeThreadId: threadId,
        collapsedProjects: [],
        expandedThreads: [],
        lastSyncAt: 0,
      },
      version: 0,
    }));
    window.localStorage.setItem(`duya:panel:v2:${threadId}`, JSON.stringify({
      tabs: [{
        id: 'workspace-tab',
        pageId: 'workspace',
        title: 'preview.md',
        params: { filePath, workingDirectory: projectDir },
      }],
      activeTabId: 'workspace-tab',
      panelOpen: true,
      panelView: 'content',
      workspaceExpanded: true,
    }));
  }, { threadId, projectDir, filePath });

  await app.page.reload({ waitUntil: 'domcontentloaded' });

  const workspace = app.page.locator('.panel-zone-expanded');
  await expect(workspace).toBeVisible({ timeout: 30_000 });
  await expect(workspace.getByText('Preview workspace')).toBeVisible();
  await expect(app.page.locator('.workspace-floating-composer')).toBeVisible();
  await expect(workspace.locator('.fw-main')).toBeVisible();
  await expect(workspace.locator('.fw-sidebar')).toBeVisible();

  const outputDir = path.resolve(__dirname, '..', '..', 'output', 'playwright');
  fs.mkdirSync(outputDir, { recursive: true });
  await app.page.screenshot({
    path: path.join(outputDir, 'file-workspace-expanded.png'),
    fullPage: false,
  });

  // The header's tree toggle flips the sidebar; the workspace panel owns both
  // the file tree and the open-file tabs, so there is no second toggle.
  await workspace.locator('.fw-head button[aria-pressed]').click();
  await expect(workspace.locator('.fw-sidebar')).toHaveCount(0);
  await app.page.getByTestId('workspace-expand').click();
  await expect(app.page.locator('.panel-zone-expanded')).toHaveCount(0);
  await expect(app.page.locator('.panel-zone-open')).toBeVisible();
});
