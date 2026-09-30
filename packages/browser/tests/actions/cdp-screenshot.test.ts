import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExtensionCDPClient, PlaywrightCDPClient } from '../../../src/tool/BrowserTool/CDPClient.js';

// Helper: simulate daemon HTTP response.
// `send()` does `result.data` on the daemon response, extracting the CDP result.
// `screenshot()` then does `result.data` on the CDP result, extracting the base64 string.
// So for a CDP Page.captureScreenshot returning { data: 'BASE64' }, the daemon wraps it as:
//   { data: { data: 'BASE64' } }
// `send()` extracts `{ data: 'BASE64' }` (the CDP result)
// `screenshot()` extracts `'BASE64'`

function daemonCDPResult(cdpResult: unknown): unknown {
  return { data: cdpResult };
}

function createExtensionClient(sessionId = 'test-session'): ExtensionCDPClient {
  const client = new ExtensionCDPClient(sessionId);
  const clientAny = client as any;
  clientAny.connected = true;
  clientAny.tabId = 42;
  clientAny.lastUrl = 'https://example.com';
  return client;
}

describe('ExtensionCDPClient.screenshot', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    if (fetchMock) fetchMock.mockRestore();
  });

  it('should throw when tabId is null', async () => {
    const client = new ExtensionCDPClient('test-session');
    (client as any).connected = true;

    await expect(client.screenshot()).rejects.toThrow(
      'No active tab. Navigate to a URL first.',
    );
  });

  describe('Approach 1: CDP Page.captureScreenshot (viewport)', () => {
    it('should succeed with viewport screenshot via CDP', async () => {
      const client = createExtensionClient();
      // Daemon wraps CDP result { data: 'c2NyZWVuc2hvdA==' } as { data: { data: 'c2NyZWVuc2hvdA==' } }
      fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => daemonCDPResult({ data: 'c2NyZWVuc2hvdA==' }),
        text: async () => '',
      } as Response);

      const result = await client.screenshot();

      expect(result).toBe('c2NyZWVuc2hvdA==');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('should send format:png in Page.captureScreenshot params', async () => {
      const client = createExtensionClient();
      let capturedBody: any = null;
      fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (_url, init) => {
          capturedBody = JSON.parse((init as any).body as string);
          return {
            ok: true,
            status: 200,
            json: async () => daemonCDPResult({ data: 'c2NyZWVuc2hvdA==' }),
            text: async () => '',
          } as Response;
        },
      );

      await client.screenshot();

      expect(capturedBody.params).toEqual({ format: 'png' });
      expect(capturedBody.method).toBe('Page.captureScreenshot');
    });
  });

  describe('Approach 1: fullPage', () => {
    it('should get layout metrics and set device override for fullPage', async () => {
      const client = createExtensionClient();
      const calls: any[] = [];
      fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (_url, init) => {
          const body = JSON.parse((init as any).body as string);
          calls.push(body);

          if (body.method === 'Page.getLayoutMetrics') {
            return {
              ok: true, status: 200,
              json: async () => daemonCDPResult({ cssContentSize: { width: 1920, height: 5000 } }),
              text: async () => '',
            } as Response;
          }
          if (body.method === 'Emulation.setDeviceMetricsOverride') {
            expect(body.params.width).toBe(1920);
            expect(body.params.height).toBe(5000);
            return {
              ok: true, status: 200,
              json: async () => daemonCDPResult({}),
              text: async () => '',
            } as Response;
          }
          if (body.method === 'Page.captureScreenshot') {
            return {
              ok: true, status: 200,
              json: async () => daemonCDPResult({ data: 'ZnVsbHBhZ2U=' }),
              text: async () => '',
            } as Response;
          }
          if (body.method === 'Emulation.clearDeviceMetricsOverride') {
            return {
              ok: true, status: 200,
              json: async () => daemonCDPResult({}),
              text: async () => '',
            } as Response;
          }
          return {
            ok: true, status: 200,
            json: async () => daemonCDPResult({}),
            text: async () => '',
          } as Response;
        },
      );

      const result = await client.screenshot({ fullPage: true });

      expect(result).toBe('ZnVsbHBhZ2U=');
      expect(calls.length).toBe(4);
      expect(calls[0].method).toBe('Page.getLayoutMetrics');
      expect(calls[1].method).toBe('Emulation.setDeviceMetricsOverride');
      expect(calls[2].method).toBe('Page.captureScreenshot');
      expect(calls[3].method).toBe('Emulation.clearDeviceMetricsOverride');
    });

    it('should clear device metrics override even when screenshot returns no data', async () => {
      const client = createExtensionClient();
      const methods: string[] = [];
      fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (_url, init) => {
          const body = JSON.parse((init as any).body as string);
          methods.push(body.method ?? body.action ?? 'unknown');

          if (body.method === 'Page.getLayoutMetrics') {
            return {
              ok: true, status: 200,
              json: async () => daemonCDPResult({ cssContentSize: { width: 800, height: 2000 } }),
              text: async () => '',
            } as Response;
          }
          if (body.method === 'Emulation.setDeviceMetricsOverride') {
            return {
              ok: true, status: 200,
              json: async () => daemonCDPResult({}),
              text: async () => '',
            } as Response;
          }
          if (body.method === 'Page.captureScreenshot') {
            return {
              ok: true, status: 200,
              json: async () => daemonCDPResult({ data: undefined }),
              text: async () => '',
            } as Response;
          }
          if (body.method === 'Emulation.clearDeviceMetricsOverride') {
            return {
              ok: true, status: 200,
              json: async () => daemonCDPResult({}),
              text: async () => '',
            } as Response;
          }
          return {
            ok: true, status: 200,
            json: async () => ({}),
            text: async () => '',
          } as Response;
        },
      );

      await expect(
        client.screenshot({ fullPage: true }),
      ).rejects.toThrow('Screenshot failed: all capture methods failed');

      expect(methods).toContain('Emulation.clearDeviceMetricsOverride');
    });

    it('should fall back to contentSize when cssContentSize is absent', async () => {
      const client = createExtensionClient();
      let deviceOverrideParams: any = null;
      fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (_url, init) => {
          const body = JSON.parse((init as any).body as string);

          if (body.method === 'Page.getLayoutMetrics') {
            return {
              ok: true, status: 200,
              json: async () => daemonCDPResult({ contentSize: { width: 1024, height: 3000 } }),
              text: async () => '',
            } as Response;
          }
          if (body.method === 'Emulation.setDeviceMetricsOverride') {
            deviceOverrideParams = body.params;
            return {
              ok: true, status: 200,
              json: async () => daemonCDPResult({}),
              text: async () => '',
            } as Response;
          }
          if (body.method === 'Page.captureScreenshot') {
            return {
              ok: true, status: 200,
              json: async () => daemonCDPResult({ data: 'Y29udGVudA==' }),
              text: async () => '',
            } as Response;
          }
          if (body.method === 'Emulation.clearDeviceMetricsOverride') {
            return {
              ok: true, status: 200,
              json: async () => daemonCDPResult({}),
              text: async () => '',
            } as Response;
          }
          return {
            ok: true, status: 200,
            json: async () => daemonCDPResult({}),
            text: async () => '',
          } as Response;
        },
      );

      await client.screenshot({ fullPage: true });

      expect(deviceOverrideParams.width).toBe(1024);
      expect(deviceOverrideParams.height).toBe(3000);
    });
  });

  describe('Approach 1: selector screenshot', () => {
    it('should use DOM API for element screenshot with clip', async () => {
      const client = createExtensionClient();
      const calls: any[] = [];
      fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (_url, init) => {
          const body = JSON.parse((init as any).body as string);
          calls.push(body);

          if (body.method === 'DOM.getDocument') {
            return {
              ok: true, status: 200,
              json: async () => daemonCDPResult({ root: { nodeId: 1 } }),
              text: async () => '',
            } as Response;
          }
          if (body.method === 'DOM.querySelector') {
            return {
              ok: true, status: 200,
              json: async () => daemonCDPResult({ nodeId: 5 }),
              text: async () => '',
            } as Response;
          }
          if (body.method === 'DOM.scrollIntoViewIfNeeded') {
            return {
              ok: true, status: 200,
              json: async () => daemonCDPResult({}),
              text: async () => '',
            } as Response;
          }
          if (body.method === 'DOM.getBoxModel') {
            return {
              ok: true, status: 200,
              json: async () => daemonCDPResult({ model: { content: [100, 200, 400, 500] } }),
              text: async () => '',
            } as Response;
          }
          if (body.method === 'Page.captureScreenshot') {
            expect(body.params.clip).toEqual({
              x: 100, y: 200, width: 300, height: 300, scale: 1,
            });
            return {
              ok: true, status: 200,
              json: async () => daemonCDPResult({ data: 'ZWxlbWVudA==' }),
              text: async () => '',
            } as Response;
          }
          return {
            ok: true, status: 200,
            json: async () => daemonCDPResult({}),
            text: async () => '',
          } as Response;
        },
      );

      const result = await client.screenshot({ selector: '.target' });

      expect(result).toBe('ZWxlbWVudA==');
      expect(calls[0].method).toBe('DOM.getDocument');
      expect(calls[1].method).toBe('DOM.querySelector');
      expect(calls[1].params.selector).toBe('.target');
    });

    it('should fall through when element not found', async () => {
      const client = createExtensionClient();
      fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (_url, init) => {
          const body = JSON.parse((init as any).body as string);

          if (body.method === 'DOM.getDocument') {
            return {
              ok: true, status: 200,
              json: async () => daemonCDPResult({ root: { nodeId: 1 } }),
              text: async () => '',
            } as Response;
          }
          if (body.method === 'DOM.querySelector') {
            return {
              ok: true, status: 200,
              json: async () => daemonCDPResult({ nodeId: 0 }),
              text: async () => '',
            } as Response;
          }
          return {
            ok: true, status: 200,
            json: async () => ({}),
            text: async () => '',
          } as Response;
        },
      );

      await expect(
        client.screenshot({ selector: '.nonexistent' }),
      ).rejects.toThrow('Screenshot failed: all capture methods failed');
    });
  });

  describe('Approach 2: Extension screenshot fallback', () => {
    it('should fall back to extension screenshot when CDP returns no data', async () => {
      const client = createExtensionClient();
      const calls: any[] = [];
      fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (_url, init) => {
          const body = JSON.parse((init as any).body as string);
          calls.push(body);

          if (body.action === 'cdp') {
            return {
              ok: true, status: 200,
              json: async () => daemonCDPResult({ data: undefined }),
              text: async () => '',
            } as Response;
          }
          if (body.action === 'screenshot') {
            expect(body.tabId).toBe(42);
            expect(body.fullPage).toBe(false);
            return {
              ok: true, status: 200,
              json: async () => ({ data: { data: 'ZXh0ZW5zaW9u' } }),
              text: async () => '',
            } as Response;
          }
          return {
            ok: true, status: 200,
            json: async () => ({ data: {} }),
            text: async () => '',
          } as Response;
        },
      );

      const result = await client.screenshot();

      expect(result).toBe('ZXh0ZW5zaW9u');
      expect(calls[0].action).toBe('cdp');
      expect(calls[1].action).toBe('screenshot');
    });

    it('should pass fullPage to extension screenshot fallback', async () => {
      const client = createExtensionClient();
      fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (_url, init) => {
          const body = JSON.parse((init as any).body as string);

          if (body.action === 'cdp') {
            return {
              ok: true, status: 200,
              json: async () => daemonCDPResult({ data: undefined }),
              text: async () => '',
            } as Response;
          }
          if (body.action === 'screenshot') {
            expect(body.fullPage).toBe(true);
            return {
              ok: true, status: 200,
              json: async () => ({ data: { data: 'ZnVsbA==' } }),
              text: async () => '',
            } as Response;
          }
          return {
            ok: true, status: 200,
            json: async () => ({ data: {} }),
            text: async () => '',
          } as Response;
        },
      );

      const result = await client.screenshot({ fullPage: true });

      expect(result).toBe('ZnVsbA==');
    });
  });

  describe('Approach 3: DOM.captureScreenshot last resort', () => {
    it('should use DOM.captureScreenshot when CDP and extension both fail', async () => {
      const client = createExtensionClient();
      const methods: string[] = [];
      fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (_url, init) => {
          const body = JSON.parse((init as any).body as string);
          methods.push(body.method ?? body.action ?? 'unknown');

          // Approach 1: CDP Page.captureScreenshot fails with non-ok response
          if (body.action === 'cdp' && body.method === 'Page.captureScreenshot') {
            return {
              ok: false, status: 500,
              json: async () => ({ ok: false, error: 'CDP captureScreenshot not available' }),
              text: async () => 'CDP error',
            } as Response;
          }

          // Approach 2: extension screenshot fails (has error field)
          if (body.action === 'screenshot') {
            return {
              ok: true, status: 200,
              json: async () => ({ error: 'not supported by extension', data: undefined }),
              text: async () => '',
            } as Response;
          }

          // Approach 3: DOM.captureScreenshot succeeds via send() (CDP path)
          if (body.method === 'DOM.getDocument') {
            return {
              ok: true, status: 200,
              json: async () => daemonCDPResult({ root: { nodeId: 1 } }),
              text: async () => '',
            } as Response;
          }
          if (body.method === 'DOM.captureScreenshot') {
            return {
              ok: true, status: 200,
              json: async () => daemonCDPResult({ data: 'ZG9t' }),
              text: async () => '',
            } as Response;
          }
          return {
            ok: true, status: 200,
            json: async () => daemonCDPResult({}),
            text: async () => '',
          } as Response;
        },
      );

      const result = await client.screenshot();

      expect(result).toBe('ZG9t');
      expect(methods).toContain('DOM.getDocument');
      expect(methods).toContain('DOM.captureScreenshot');
    });
  });

  describe('All approaches fail', () => {
    it('should throw comprehensive error when all methods fail', async () => {
      const client = createExtensionClient();
      fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
        async () => ({
          ok: false, status: 500,
          json: async () => ({ ok: false, error: 'not available' }),
          text: async () => 'error',
        } as Response),
      );

      await expect(client.screenshot()).rejects.toThrow(
        'Screenshot failed: all capture methods failed',
      );
    });
  });
});

describe('PlaywrightCDPClient.screenshot', () => {
  it('should call page.screenshot() for viewport', async () => {
    const client = new PlaywrightCDPClient();
    const mockBuffer = Buffer.from('pngdata');
    const mockPage = {
      screenshot: vi.fn().mockResolvedValue(mockBuffer),
    };
    (client as any).page = mockPage;
    (client as any).connected = true;

    const result = await client.screenshot();

    expect(result).toBe(mockBuffer.toString('base64'));
    expect(mockPage.screenshot).toHaveBeenCalledWith();
  });

  it('should call page.screenshot({ fullPage: true }) for full page', async () => {
    const client = new PlaywrightCDPClient();
    const mockBuffer = Buffer.from('fullpagedata');
    const mockPage = {
      screenshot: vi.fn().mockResolvedValue(mockBuffer),
    };
    (client as any).page = mockPage;
    (client as any).connected = true;

    const result = await client.screenshot({ fullPage: true });

    expect(mockPage.screenshot).toHaveBeenCalledWith({ fullPage: true });
    expect(result).toBe(mockBuffer.toString('base64'));
  });

  it('should call element.screenshot() for selector', async () => {
    const client = new PlaywrightCDPClient();
    const mockBuffer = Buffer.from('elementdata');
    const mockLocator = {
      screenshot: vi.fn().mockResolvedValue(mockBuffer),
    };
    const mockPage = {
      locator: vi.fn().mockReturnValue(mockLocator),
    };
    (client as any).page = mockPage;
    (client as any).connected = true;

    const result = await client.screenshot({ selector: '#main' });

    expect(mockPage.locator).toHaveBeenCalledWith('#main');
    expect(mockLocator.screenshot).toHaveBeenCalled();
    expect(result).toBe(mockBuffer.toString('base64'));
  });
});