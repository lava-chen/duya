import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screenshotAction } from '../../../src/tool/BrowserTool/actions/screenshot.js';

// Only writeFile is wrapped; mkdir and the real read/write stay intact so
// the persistence tests exercise an actual filesystem round-trip.
const mocks = vi.hoisted(() => ({ writeFileShouldFail: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: async (path: string, data: Uint8Array) => {
      if (mocks.writeFileShouldFail) {
        throw new Error('ENOSPC: no space left on device');
      }
      return actual.writeFile(path, data);
    },
  };
});
import type { ActionContext } from '../../../src/tool/BrowserTool/actions/types.js';
import type { ICDPClient } from '../../../src/tool/BrowserTool/CDPClient.js';

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
      // Captures are persisted to a temp PNG so the vision loop can hand
      // vision_analyze a short filePath instead of an inline base64 data URL.
      expect(result.filePath).toMatch(/duya-screenshots[/\\]shot-\d+-[a-z0-9]+\.png$/);
      expect(result.screenshot).toBeUndefined();
      expect(result.fullPage).toBe(false);
      expect(result.selector).toBeUndefined();
      expect(result.mode).toBe('extension');
    });

    it('should pass fullPage=true to cdp.screenshot()', async () => {
      const mockCDP = createMockCDP();
      const ctx = createMockContext({ cdp: mockCDP });

      const result = await screenshotAction.execute({ fullPage: true }, ctx);

      expect(mockCDP.screenshot).toHaveBeenCalledWith({
        fullPage: true,
        selector: undefined,
      });
      expect(result.filePath).toBeDefined();
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

    it('should persist the capture as a decodable PNG file', async () => {
      const mockCDP = createMockCDP({
        screenshot: vi.fn().mockResolvedValue('YWJjZGVm'),
      });
      const ctx = createMockContext({ cdp: mockCDP });

      const result = await screenshotAction.execute({}, ctx);

      expect(result.filePath).toBeDefined();
      // The file must contain the decoded payload, not the base64 text.
      const { readFile, rm } = await import('node:fs/promises');
      const written = await readFile(result.filePath as string);
      expect(written.toString('utf8')).toBe('abcdef');
      await rm(result.filePath as string, { force: true });
    });

    it('should fall back to an inline data URL when persisting the file fails', async () => {
      const mockCDP = createMockCDP({
        screenshot: vi.fn().mockResolvedValue('YWJjZGVm'),
      });
      const ctx = createMockContext({ cdp: mockCDP });

      // The persistence step must never lose the capture: a failed write
      // degrades to the inline data URL rather than dropping the image.
      mocks.writeFileShouldFail = true;
      try {
        const result = await screenshotAction.execute({}, ctx);

        expect(result.filePath).toBeUndefined();
        expect(result.screenshot).toBe('data:image/png;base64,YWJjZGVm');
      } finally {
        mocks.writeFileShouldFail = false;
      }
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

