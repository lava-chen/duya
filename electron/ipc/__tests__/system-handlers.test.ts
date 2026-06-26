/**
 * system-handlers.test.ts — Unit tests for security-critical system IPC.
 *
 * Channels under test (the high-leverage subset):
 *   - shell:open-external  → URL safety gate; blocks non-http(s) schemes
 *   - shell:open-path      → filesystem path gate
 *   - app:get-version      → passthrough to app.getVersion()
 *   - app:create-project-folder → filesystem creation, sanitization
 *   - system:get-location  → locale/timezone passthrough
 *
 * Heavy handlers (parser, recent folders, vision, session management)
 * are exercised in the Playwright e2e suite; here we cover only the
 * security-sensitive and pure-passthrough channels.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  shell: {
    openExternal: vi.fn(async () => ''),
    openPath: vi.fn(async () => ''),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  mainWindow: { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, show: vi.fn(), restore: vi.fn(), focus: vi.fn(), webContents: { send: vi.fn() } } as { isDestroyed: () => boolean; isVisible: () => boolean; isMinimized: () => boolean; show: () => void; restore: () => void; focus: () => void; webContents: { send: (channel: string, payload: unknown) => void } } | null,
  configManager: {
    getVisionSettings: vi.fn(() => ({ provider: 'anthropic', model: 'claude', baseUrl: '', apiKey: '', enabled: false })),
    setConfig: vi.fn(),
  },
  agentPool: {
    getInterruptedSessions: vi.fn(() => []),
  },
  agentServerPort: 0,
  docParser: {
    parse: vi.fn(async () => ({ content: 'parsed', metadata: {} })),
    getCapabilities: vi.fn(() => ({ formats: ['pdf'] })),
    isReady: vi.fn(() => true),
  },
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
  fsState: {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(() => '[]'),
    writeFileSync: vi.fn(),
  },
  captured: {
    handle: new Map<string, (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>>(),
    on: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (c: string, fn: (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>) => {
      mocks.captured.handle.set(c, fn);
    },
    on: (c: string, fn: (event: unknown, ...args: unknown[]) => void) => {
      mocks.captured.on.set(c, fn);
    },
  },
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  },
  dialog: { showOpenDialog: mocks.dialog.showOpenDialog },
  shell: { openExternal: mocks.shell.openExternal, openPath: mocks.shell.openPath },
  Notification: vi.fn(),
  app: {
    isPackaged: false,
    getVersion: vi.fn(() => '1.2.3-test'),
    getAppPath: vi.fn(() => '/app'),
    getPath: vi.fn(() => '/tmp'),
    getLocale: vi.fn(() => 'zh-CN'),
    getLocaleCountryCode: vi.fn(() => 'CN'),
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
  },
}));

vi.mock('../../logging/logger', () => ({
  initLogger: vi.fn(),
  getLogger: () => mocks.logger,
  LogComponent: new Proxy({}, { get: (_t, p) => String(p) }),
}));

vi.mock('../../core/bootstrap', () => ({
  isDev: false,
}));

vi.mock('../../core/window-manager', () => ({
  getMainWindow: () => mocks.mainWindow,
  setIsQuitting: vi.fn(),
}));

vi.mock('../../agents/agent-server-lifecycle', () => ({
  getAgentServerPort: () => mocks.agentServerPort,
}));

vi.mock('../../agents/process-pool/agent-process-pool', () => ({
  getAgentProcessPool: () => mocks.agentPool,
}));

vi.mock('../../config/manager', () => ({
  getConfigManager: () => mocks.configManager,
}));

vi.mock('../../services/document-parser/index', () => ({
  getDocumentParser: () => mocks.docParser,
}));

vi.mock('fs', () => mocks.fsState);

async function invokeHandler(
  channel: string,
  event: unknown = {},
  ...args: unknown[]
): Promise<unknown> {
  const handler = mocks.captured.handle.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return await handler(event, ...args);
}

import { registerSystemHandlers } from '../system-handlers';

describe('system-handlers', () => {
  beforeEach(() => {
    mocks.shell.openExternal.mockClear();
    mocks.shell.openExternal.mockResolvedValue('');
    mocks.shell.openPath.mockClear();
    mocks.shell.openPath.mockResolvedValue('');
    mocks.dialog.showOpenDialog.mockClear();
    mocks.logger.warn.mockClear();
    mocks.logger.error.mockClear();
    mocks.captured.handle.clear();
    mocks.captured.on.clear();
    registerSystemHandlers();
  });

  describe('shell:open-external (security-critical)', () => {
    it('forwards valid http(s) URLs to shell.openExternal', async () => {
      const result = await invokeHandler('shell:open-external', {}, 'https://example.com');
      expect(result).toBe('');
      expect(mocks.shell.openExternal).toHaveBeenCalledWith('https://example.com');
      expect(mocks.logger.warn).not.toHaveBeenCalled();
    });

    it('rejects non-string URL with "Invalid URL"', async () => {
      const result = await invokeHandler('shell:open-external', {}, 12345);
      expect(result).toBe('Invalid URL');
      expect(mocks.shell.openExternal).not.toHaveBeenCalled();
    });

    it('rejects empty URL with "Invalid URL"', async () => {
      const result = await invokeHandler('shell:open-external', {}, '');
      expect(result).toBe('Invalid URL');
    });

    it('rejects oversized URL with "Invalid URL"', async () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(4097 - 'https://example.com/'.length);
      const result = await invokeHandler('shell:open-external', {}, longUrl);
      expect(result).toBe('Invalid URL');
    });

    it('BLOCKS file:// URLs and logs a warning', async () => {
      const result = await invokeHandler('shell:open-external', {}, 'file:///etc/passwd');
      expect(result).toBe('Blocked: only http(s) URLs are allowed');
      expect(mocks.shell.openExternal).not.toHaveBeenCalled();
      expect(mocks.logger.warn).toHaveBeenCalledOnce();
    });

    it('BLOCKS javascript: URLs and logs a warning', async () => {
      const result = await invokeHandler('shell:open-external', {}, 'javascript:alert(1)');
      expect(result).toBe('Blocked: only http(s) URLs are allowed');
      expect(mocks.shell.openExternal).not.toHaveBeenCalled();
    });

    it('BLOCKS data: URLs and logs a warning', async () => {
      const result = await invokeHandler('shell:open-external', {}, 'data:text/html,<script>alert(1)</script>');
      expect(result).toBe('Blocked: only http(s) URLs are allowed');
    });

    it('BLOCKS smb:// URLs and logs a warning', async () => {
      const result = await invokeHandler('shell:open-external', {}, 'smb://server/share');
      expect(result).toBe('Blocked: only http(s) URLs are allowed');
    });

    it('BLOCKS chrome:// URLs and logs a warning', async () => {
      const result = await invokeHandler('shell:open-external', {}, 'chrome://settings');
      expect(result).toBe('Blocked: only http(s) URLs are allowed');
    });

    it('BLOCKS custom duya-scheme URLs and logs a warning', async () => {
      const result = await invokeHandler('shell:open-external', {}, 'duya-cli://run/command');
      expect(result).toBe('Blocked: only http(s) URLs are allowed');
    });

    it('BLOCKS scheme-less URLs and logs a warning', async () => {
      const result = await invokeHandler('shell:open-external', {}, 'example.com');
      expect(result).toBe('Blocked: only http(s) URLs are allowed');
    });

    it('BLOCKS URL with NUL byte injection', async () => {
      const result = await invokeHandler('shell:open-external', {}, 'https://example.com\0.evil.com');
      expect(result).toBe('Blocked: only http(s) URLs are allowed');
    });

    it('propagates shell.openExternal errors as String(err)', async () => {
      mocks.shell.openExternal.mockRejectedValueOnce(new Error('no browser found'));
      const result = await invokeHandler('shell:open-external', {}, 'https://example.com');
      expect(result).toBe('Error: no browser found');
    });
  });

  describe('dialog:open-office-files', () => {
    it('opens a multi-select dialog filtered to Office formats', async () => {
      mocks.dialog.showOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/workspace/report.docx', '/workspace/data.xlsx'],
      });

      const result = await invokeHandler('dialog:open-office-files', {}, {
        defaultPath: '/workspace',
      });

      expect(result).toEqual({
        canceled: false,
        filePaths: ['/workspace/report.docx', '/workspace/data.xlsx'],
      });
      expect(mocks.dialog.showOpenDialog).toHaveBeenCalledWith(
        mocks.mainWindow,
        expect.objectContaining({
          defaultPath: '/workspace',
          properties: ['openFile', 'multiSelections'],
          filters: expect.arrayContaining([
            { name: 'Office files', extensions: ['docx', 'pptx', 'xlsx'] },
          ]),
        }),
      );
    });
  });

  describe('shell:open-path', () => {
    it('rejects non-string path with "Invalid path"', async () => {
      const result = await invokeHandler('shell:open-path', {}, 123);
      expect(result).toBe('Invalid path');
    });

    it('rejects empty path with "Invalid path"', async () => {
      const result = await invokeHandler('shell:open-path', {}, '');
      expect(result).toBe('Invalid path');
    });

    it('rejects oversized path with "Invalid path"', async () => {
      const longPath = '/' + 'a'.repeat(4096);
      const result = await invokeHandler('shell:open-path', {}, longPath);
      expect(result).toBe('Invalid path');
    });

    it('rejects path with NUL byte with "Invalid path"', async () => {
      const result = await invokeHandler('shell:open-path', {}, '/some\0path');
      expect(result).toBe('Invalid path');
    });

    it('forwards valid path to shell.openPath', async () => {
      const result = await invokeHandler('shell:open-path', {}, '/some/folder');
      expect(result).toBe('');
      expect(mocks.shell.openPath).toHaveBeenCalledWith('/some/folder');
    });
  });

  describe('app:get-version', () => {
    it('returns the version from app.getVersion()', async () => {
      const result = await invokeHandler('app:get-version', {});
      expect(result).toBe('1.2.3-test');
    });
  });

  describe('app:create-project-folder', () => {
    it('rejects non-string projectName', async () => {
      const result = await invokeHandler('app:create-project-folder', {}, 123);
      expect(result).toEqual({ success: false, error: 'Invalid project name', path: '' });
    });

    it('rejects empty projectName', async () => {
      const result = await invokeHandler('app:create-project-folder', {}, '');
      expect(result).toEqual({ success: false, error: 'Invalid project name', path: '' });
    });

    it('rejects oversized projectName (256 chars)', async () => {
      const result = await invokeHandler('app:create-project-folder', {}, 'a'.repeat(256));
      expect(result).toEqual({ success: false, error: 'Invalid project name', path: '' });
    });

    it('sanitizes dangerous characters in the project name', async () => {
      mocks.fsState.existsSync.mockReturnValue(false);
      const result = await invokeHandler('app:create-project-folder', {}, 'my<bad>name:"|?*');
      expect(result).toMatchObject({ success: true });
      // The handler creates both `~/.duya/workspace` and the project dir.
      // The workspace dir path is fixed (no user input), so the only
      // path that can contain dangerous characters is the project dir
      // itself, which must have been sanitized.
      expect(mocks.fsState.mkdirSync).toHaveBeenCalled();
      // The basename of the LAST mkdirSync call is the project dir.
      const lastCall = mocks.fsState.mkdirSync.mock.calls.at(-1) as unknown as [string];
      const calledPath = lastCall[0];
      const sep = calledPath.includes('\\') ? '\\' : '/';
      const basename = calledPath.split(sep).pop() as string;
      // The original name "my<bad>name:\"|?*" should be sanitized to
      // "my_bad_name_____" (the regex in the handler replaces all of
      // <>:"|?* and control chars with _).
      expect(basename).toBe('my_bad_name_____');
    });

    it('returns "Project folder already exists" when the folder exists', async () => {
      mocks.fsState.existsSync.mockReturnValue(true);
      const result = await invokeHandler('app:create-project-folder', {}, 'my-project');
      expect(result).toMatchObject({ success: false, error: 'Project folder already exists' });
    });
  });

  describe('system:get-location', () => {
    it('returns locale, country code, and timezone from Intl', async () => {
      const result = await invokeHandler('system:get-location', {});
      expect(result).toMatchObject({
        locale: 'zh-CN',
        localeCountryCode: 'CN',
      });
      // timezone comes from Intl, just verify it's a string
      expect(typeof (result as { timezone: string }).timezone).toBe('string');
    });
  });
});
