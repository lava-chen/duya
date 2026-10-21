import { beforeEach, describe, expect, it, vi } from 'vitest';

const { client, clientConstructor } = vi.hoisted(() => ({
  client: {
    health: vi.fn(),
    navigate: vi.fn(),
    getUrl: vi.fn(),
    getTitle: vi.fn(),
    click: vi.fn(),
    evaluate: vi.fn(),
    type: vi.fn(),
    pressKey: vi.fn(),
    scroll: vi.fn(),
    waitForElement: vi.fn(),
    screenshot: vi.fn(),
    closeSession: vi.fn(),
    close: vi.fn(),
  },
  clientConstructor: vi.fn(),
}));

vi.mock('@duya/capabilities/BrowserTool/CDPClient', () => ({
  ExtensionCDPClient: class {
    constructor(sessionId: string) {
      clientConstructor(sessionId);
      return client;
    }
  },
}));

import {
  BROWSER_BRIDGE_UNAVAILABLE,
  createExtensionBrowserBackend,
  runBrowserWithExtensionBackend,
} from '../../src/worker-workflows/browser-backend.js';

beforeEach(() => {
  for (const value of Object.values(client)) value.mockReset();
  client.health.mockResolvedValue({ status: 'ok', mode: 'extension' });
  client.getUrl.mockResolvedValue('https://example.test/');
  client.getTitle.mockResolvedValue('Example');
  client.evaluate.mockResolvedValue(undefined);
  client.screenshot.mockResolvedValue('base64');
  clientConstructor.mockReset();
});

describe('Host extension browser backend', () => {
  it('binds the extension session and reads navigation state', async () => {
    const backend = createExtensionBrowserBackend('workflow-session');
    await backend.connect();
    const result = await backend.run({ do: 'navigate', url: 'https://example.test/' });

    expect(clientConstructor).toHaveBeenCalledWith('workflow-session');
    expect(client.health).toHaveBeenCalledTimes(1);
    expect(client.navigate).toHaveBeenCalledWith('https://example.test/');
    expect(result).toEqual({
      ok: true,
      data: { url: 'https://example.test/', title: 'Example' },
    });
  });

  it('uses the native value setter and dispatches input/change events', async () => {
    const backend = createExtensionBrowserBackend('workflow-session');
    const result = await backend.run({ do: 'set_value', selector: '#search', value: 'duya' });

    const script = client.evaluate.mock.calls[0]?.[0];
    expect(script).toContain('document.querySelector("#search")');
    expect(script).toContain('desc.set.call(el, "duya")');
    expect(script).toContain("new Event('input', { bubbles: true })");
    expect(script).toContain("new Event('change', { bubbles: true })");
    expect(result).toEqual({ ok: true });
  });

  it('returns the established actionable error when the bridge is unavailable', async () => {
    client.health.mockResolvedValue({ status: 'disconnected', mode: 'extension' });
    const backend = createExtensionBrowserBackend('workflow-session');

    await expect(backend.connect()).rejects.toThrow(BROWSER_BRIDGE_UNAVAILABLE);
  });

  it('closes the extension session after a browser node finishes', async () => {
    const result = await runBrowserWithExtensionBackend(
      'workflow-session',
      { steps: [] },
      { runId: 'run-1' },
    );

    expect(result).toEqual({ status: 'succeeded', output: { steps: 0 } });
    expect(client.closeSession).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledTimes(1);
  });
});
