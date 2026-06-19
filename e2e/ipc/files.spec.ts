/**
 * files.spec.ts — E2E for files:browse / files:delete / files:rename.
 *
 * Unlike the unit tests (which mock `fs`), these specs do a real
 * filesystem round-trip inside the Electron Main process. The temp dir
 * is created under the test namespace's userData so it's isolated and
 * cleaned up with the namespace.
 */
import { test, expect } from '@playwright/test';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { launchDuya, invokeApi, closeDuya, type DuyaApp } from '../helpers';

let app: DuyaApp;
let sandboxDir: string;

test.beforeEach(async () => {
  sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-e2e-files-'));
});

test.afterEach(async () => {
  if (app) {
    await closeDuya(app.app);
    app = undefined as unknown as DuyaApp;
  }
  // Best-effort cleanup of the sandbox dir.
  try {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

test('files:browse returns a tree for a valid directory', async () => {
  app = await launchDuya({ namespace: 'files-browse' });
  // Create a known structure in the sandbox.
  fs.mkdirSync(path.join(sandboxDir, 'subdir'), { recursive: true });
  fs.writeFileSync(path.join(sandboxDir, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(sandboxDir, 'subdir', 'b.md'), 'world');

  const result = await invokeApi<{
    success: boolean;
    error?: string;
    tree: Array<{ name: string; path: string; type: string; children?: unknown[] }>;
  }>(app.page, 'files.browse', sandboxDir, 2);

  expect(result.success).toBe(true);
  expect(Array.isArray(result.tree)).toBe(true);
  const names = result.tree.map((n) => n.name);
  expect(names).toContain('a.txt');
  expect(names).toContain('subdir');
});

test('files:browse rejects non-existent path', async () => {
  app = await launchDuya({ namespace: 'files-browse-missing' });
  const result = await invokeApi<{ success: boolean; error?: string; tree: unknown[] }>(
    app.page,
    'files.browse',
    path.join(sandboxDir, 'does-not-exist'),
  );
  expect(result.success).toBe(false);
  expect(result.error).toBeTruthy();
});

test('files:delete removes a file', async () => {
  app = await launchDuya({ namespace: 'files-delete' });
  const filePath = path.join(sandboxDir, 'to-delete.txt');
  fs.writeFileSync(filePath, 'bye');

  const result = await invokeApi<{ success: boolean; error?: string }>(
    app.page,
    'files.delete',
    filePath,
  );
  expect(result.success).toBe(true);
  expect(fs.existsSync(filePath)).toBe(false);
});

test('files:delete rejects non-existent path', async () => {
  app = await launchDuya({ namespace: 'files-delete-missing' });
  const result = await invokeApi<{ success: boolean; error?: string }>(
    app.page,
    'files.delete',
    path.join(sandboxDir, 'nope.txt'),
  );
  expect(result.success).toBe(false);
  expect(result.error).toBeTruthy();
});

test('files:rename renames a file and returns the new path', async () => {
  app = await launchDuya({ namespace: 'files-rename' });
  const oldPath = path.join(sandboxDir, 'old-name.txt');
  fs.writeFileSync(oldPath, 'content');

  const result = await invokeApi<{ success: boolean; error?: string; newPath?: string }>(
    app.page,
    'files.rename',
    oldPath,
    'new-name.txt',
  );
  expect(result.success).toBe(true);
  expect(result.newPath).toBeTruthy();
  expect(fs.existsSync(oldPath)).toBe(false);
  expect(fs.existsSync(result.newPath as string)).toBe(true);
});

test('files:rename rejects when target name already exists', async () => {
  app = await launchDuya({ namespace: 'files-rename-collision' });
  const oldPath = path.join(sandboxDir, 'original.txt');
  const existingPath = path.join(sandboxDir, 'existing.txt');
  fs.writeFileSync(oldPath, 'a');
  fs.writeFileSync(existingPath, 'b');

  const result = await invokeApi<{ success: boolean; error?: string }>(
    app.page,
    'files.rename',
    oldPath,
    'existing.txt',
  );
  expect(result.success).toBe(false);
  expect(result.error).toBeTruthy();
});
