import { describe, it, expect, vi, beforeEach } from 'vitest';

// The action persists the PNG to a temp file (so the vision loop can pass a
// short filePath instead of an inline base64 data URL) and only falls back to
// the inline URL when the write fails. Mock both so each branch is
// deterministic instead of depending on the host tmpdir being writable.
const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: fsMocks.mkdir, writeFile: fsMocks.writeFile };
});

import { screenshotAction } from '../../src/actions/screenshot.js';
import type { ActionContext } from '../../src/actions/types.js';
import type { ICDPClient } from '../../src/CDPClient.js';

function createMockCDP(overrides: Partial<ICDPClient> = {}): ICDPClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ status: 'ok', mode: 'extension' }),
    navigate: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({}),
    evaluate: vi.fn().mockResolvedValue(null),
    screenshot: vi.fn().mockResolvedValue('base64pngdata'),
    click: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    scroll: vi.fn().mockResolvedValue(undefined),
    goBack: vi.fn().mockResolvedValue(undefined),
    pressKey: vi.fn().mockResolvedValue(undefined),
    getUrl: vi.fn().mockResolvedValue('https://example.com'),
    getTitle: vi.fn().mockResolvedValue('Example'),
    close: vi.fn().mockResolvedValue(undefined),
    closeWindow: vi.fn().mockResolvedValue(undefined),
    tabs: vi.fn().mockResolvedValue([]),
    newTab: vi.fn().mockResolvedValue('1'),
    closeTab: vi.fn().mockResolvedValue(undefined),
    selectTab: vi.fn().mockResolvedValue(undefined),
    setFileInput: vi.fn().mockResolvedValue(undefined),
    startNetworkCapture: vi.fn().mockResolvedValue(true),
    readNetworkCapture: vi.fn().mockResolvedValue([]),
    getCookies: vi.fn().mockResolvedValue([]),
    frames: vi.fn().mockResolvedValue([]),
    evaluateInFrame: vi.fn().mockResolvedValue(null),
    hover: vi.fn().mockResolvedValue(undefined),
    waitForElement: vi.fn().mockResolvedValue(undefined),
    waitForLoad: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
    cdp: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function createMockContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    cdp: null,
    snapshotEngine: null,
    fallbackBrowser: null,
    mode: 'extension',
    extensionAvailable: true,
    browserBackendMode: 'auto',
    platformHookManager: {
      shouldApplyHooks: vi.fn().mockReturnValue(false),
      applyPostNavigateHooks: vi.fn().mockResolvedValue(undefined),
      hasExtractor: vi.fn().mockReturnValue(false),
      extractContent: vi.fn().mockResolvedValue(null),
    },
    checkDomainBlocked: vi.fn().mockReturnValue(false),
    getBrowserPool: vi.fn().mockReturnValue({} as any),
    ...overrides,
  };
}

describe('screenshotAction', () => {
  beforeEach(() => {
    fsMocks.mkdir.mockReset().mockResolvedValue(undefined);
    fsMocks.writeFile.mockReset().mockResolvedValue(undefined);
  });

  describe('execute', () => {
    it('should call cdp.screenshot() with no options by default', async () => {
      const mockCDP = createMockCDP();
      const ctx = createMockContext({ cdp: mockCDP });

      // execute receives parsed input from ActionRegistry (zod fills defaults)
      const result = await screenshotAction.execute(
        { fullPage: false },
        ctx,
      );

      expect(mockCDP.screenshot).toHaveBeenCalledWith({
        fullPage: false,
        selector: undefined,
      });
      // Default path: the PNG is written to a temp file, not inlined.
      expect(result.screenshot).toBeUndefined();
      expect(result.filePath).toMatch(/shot-.*\.png$/);
      expect(fsMocks.writeFile).toHaveBeenCalledWith(
        result.filePath,
        Buffer.from('base64pngdata', 'base64'),
      );
      expect(result).toEqual({
        filePath: result.filePath,
        fullPage: false,
        selector: undefined,
        mode: 'extension',
      });
    });

    it('should pass fullPage=true to cdp.screenshot()', async () => {
      const mockCDP = createMockCDP();
      const ctx = createMockContext({ cdp: mockCDP });

      const result = await screenshotAction.execute({ fullPage: true }, ctx);

      expect(mockCDP.screenshot).toHaveBeenCalledWith({
        fullPage: true,
        selector: undefined,
      });
      expect(result.filePath).toMatch(/shot-.*\.png$/);
      expect(result.fullPage).toBe(true);
    });

    it('should pass selector to cdp.screenshot()', async () => {
      const mockCDP = createMockCDP();
      const ctx = createMockContext({ cdp: mockCDP });

      const result = await screenshotAction.execute(
        { fullPage: false, selector: '#main' },
        ctx,
      );

      expect(mockCDP.screenshot).toHaveBeenCalledWith({
        fullPage: false,
        selector: '#main',
      });
      expect(result.selector).toBe('#main');
    });

    it('should return error when cdp is null (fallback mode)', async () => {
      const ctx = createMockContext({ cdp: null, mode: 'fallback' });

      const result = await screenshotAction.execute({}, ctx);

      expect(result).toEqual({
        error: 'Screenshots not available in fallback mode',
        mode: 'fallback',
      });
    });

    it('should include mode in result', async () => {
      const mockCDP = createMockCDP();
      const ctx = createMockContext({ cdp: mockCDP, mode: 'playwright' });

      const result = await screenshotAction.execute({}, ctx);

      expect(result.mode).toBe('playwright');
    });

    it('should prepend data:image/png;base64, prefix when the temp write fails', async () => {
      // Inline base64 is the degraded path: only used when the PNG cannot be
      // persisted (read-only tmpdir, disk full, permissions).
      fsMocks.writeFile.mockRejectedValueOnce(new Error('EACCES'));
      const mockCDP = createMockCDP({
        screenshot: vi.fn().mockResolvedValue('YWJjZGVm'),
      });
      const ctx = createMockContext({ cdp: mockCDP });

      const result = await screenshotAction.execute({}, ctx);

      expect(result.filePath).toBeUndefined();
      expect(result.screenshot).toBe('data:image/png;base64,YWJjZGVm');
    });

    it('should also fall back to the inline URL when the temp dir cannot be created', async () => {
      fsMocks.mkdir.mockRejectedValueOnce(new Error('EROFS'));
      const mockCDP = createMockCDP();
      const ctx = createMockContext({ cdp: mockCDP });

      const result = await screenshotAction.execute({}, ctx);

      expect(result.filePath).toBeUndefined();
      expect(result.screenshot).toBe('data:image/png;base64,base64pngdata');
      expect(fsMocks.writeFile).not.toHaveBeenCalled();
    });

    it('should propagate errors from cdp.screenshot()', async () => {
      const mockCDP = createMockCDP({
        screenshot: vi
          .fn()
          .mockRejectedValue(new Error('Capture failed')),
      });
      const ctx = createMockContext({ cdp: mockCDP });

      await expect(screenshotAction.execute({}, ctx)).rejects.toThrow(
        'Capture failed',
      );
    });
  });

  describe('schema validation', () => {
    it('should accept empty input with default values', () => {
      const result = screenshotAction.schema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.fullPage).toBe(false);
        expect(result.data.selector).toBeUndefined();
      }
    });

    it('should accept fullPage=true', () => {
      const result = screenshotAction.schema.safeParse({ fullPage: true });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.fullPage).toBe(true);
      }
    });

    it('should accept selector string', () => {
      const result = screenshotAction.schema.safeParse({
        selector: '.header',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.selector).toBe('.header');
      }
    });

    it('should reject invalid types', () => {
      const result = screenshotAction.schema.safeParse({
        fullPage: 'yes',
      });
      expect(result.success).toBe(false);
    });

    it('should accept both fullPage and selector together', () => {
      const result = screenshotAction.schema.safeParse({
        fullPage: true,
        selector: '#main',
      });
      expect(result.success).toBe(true);
    });
  });
});

