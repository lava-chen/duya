/**
 * logger.spec.ts — E2E for logger IPC handlers.
 *
 * Channels covered:
 *   - logger:export         → returns log content as string
 *   - logger:get-path       → returns logPath/logDir/size/sizeFormatted
 *   - logger:export-to-file → rejects invalid target path
 *
 * The logger writes to %APPDATA%/DUYA/logs/app.log (rotated daily). Under
 * DUYA_TEST=1 the namespace isolates userData, so the log file is fresh
 * per spec.
 */
import { test, expect } from '@playwright/test';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { launchDuya, invokeApi, closeDuya, type DuyaApp } from '../helpers';

let app: DuyaApp;

test.afterEach(async () => {
  if (app) {
    await closeDuya(app.app);
    app = undefined as unknown as DuyaApp;
  }
});

test('logger:get-path returns logPath, logDir, and size', async () => {
  app = await launchDuya({ namespace: 'logger-path' });
  const result = await invokeApi<{
    logPath: string;
    logDir: string;
    size: number;
    sizeFormatted: string;
  }>(app.page, 'logger.getPath');

  expect(typeof result.logPath).toBe('string');
  expect(result.logPath.length).toBeGreaterThan(0);
  expect(typeof result.logDir).toBe('string');
  expect(typeof result.size).toBe('number');
  expect(typeof result.sizeFormatted).toBe('string');
});

test('logger:export returns success with logs string', async () => {
  app = await launchDuya({ namespace: 'logger-export' });
  const result = await invokeApi<{ success: boolean; logs?: string; error?: string }>(
    app.page,
    'logger.export',
  );
  expect(result.success).toBe(true);
  expect(typeof result.logs).toBe('string');
});

test('logger:export-to-file rejects invalid target path', async () => {
  app = await launchDuya({ namespace: 'logger-export-reject' });
  // Pass an empty string — handler should reject with "Invalid target path".
  const result = await invokeApi<{ success: boolean; error?: string }>(
    app.page,
    'logger.exportToFile',
    '',
  );
  expect(result.success).toBe(false);
  expect(result.error).toContain('Invalid');
});

test('logger:export-to-file writes to a real path', async () => {
  app = await launchDuya({ namespace: 'logger-export-real' });
  const tmpFile = path.join(
    os.tmpdir(),
    `duya-e2e-logger-${Date.now()}.log`,
  );
  try {
    const result = await invokeApi<{ success: boolean; error?: string }>(
      app.page,
      'logger.exportToFile',
      tmpFile,
    );
    expect(result.success).toBe(true);
    expect(fs.existsSync(tmpFile)).toBe(true);
    const content = fs.readFileSync(tmpFile, 'utf-8');
    expect(content.length).toBeGreaterThanOrEqual(0);
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore
    }
  }
});
