import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebviewCDPClient } from '../../src/tool/BrowserTool/WebviewCDPClient.js';

interface RequestRecord {
  url: string;
  body: Record<string, unknown>;
}

function installFetchMock(records: RequestRecord[]): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    records.push({ url, body });
    if (url.endsWith('/ping')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (url.endsWith('/webview-network-read')) {
      return new Response(JSON.stringify({ ok: true, data: [{ url: 'https://example.com/api', method: 'GET' }] }));
    }
    if (body.method === 'DOM.getDocument') {
      return new Response(JSON.stringify({ id: body.id, ok: true, result: { root: { nodeId: 1 } } }));
    }
    if (body.method === 'DOM.querySelector') {
      return new Response(JSON.stringify({ id: body.id, ok: true, result: { nodeId: 7 } }));
    }
    if (body.method === 'DOM.getBoxModel') {
      return new Response(JSON.stringify({
        id: body.id,
        ok: true,
        result: { model: { content: [10, 20, 70, 20, 70, 60, 10, 60] } },
      }));
    }
    if (body.method === 'Runtime.evaluate') {
      return new Response(JSON.stringify({
        id: body.id,
        ok: true,
        result: { result: { value: body.params?.contextId ? 'frame-result' : { ok: true } } },
      }));
    }
    if (body.method === 'Page.getFrameTree') {
      return new Response(JSON.stringify({
        id: body.id,
        ok: true,
        result: {
          frameTree: {
            frame: { id: 'main-frame', url: 'https://example.com' },
            childFrames: [
              { frame: { id: 'child-a', url: 'https://a.example', name: 'first' } },
              { frame: { id: 'child-b', url: 'https://b.example', name: 'second' } },
            ],
          },
        },
      }));
    }
    if (body.method === 'Page.createIsolatedWorld') {
      return new Response(JSON.stringify({ id: body.id, ok: true, result: { executionContextId: 42 } }));
    }
    if (body.method === 'Page.captureScreenshot') {
      return new Response(JSON.stringify({ id: body.id, ok: true, result: { data: 'PNG_BASE64' } }));
    }
    return new Response(JSON.stringify({ id: body.id, ok: true, result: {} }), { status: 200 });
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('WebviewCDPClient tab management', () => {
  it('creates, selects, and closes separate webview-backed tabs', async () => {
    const records: RequestRecord[] = [];
    installFetchMock(records);
    const client = new WebviewCDPClient('chat-session');
    await client.connect();

    const tabId = await client.newTab('https://example.com');
    expect(tabId).toBe('tab_1');
    expect(records.some((request) => request.body.sessionId === 'chat-session::tab_1')).toBe(true);

    await client.selectTab(tabId!);
    expect(records.at(-1)?.url).toContain('/webview-activate');
    expect(records.at(-1)?.body.sessionId).toBe('chat-session::tab_1');

    await client.closeTab(tabId!);
    expect(records.at(-1)?.url).toContain('/webview-close');
    expect(records.at(-1)?.body.sessionId).toBe('chat-session::tab_1');
  });

  it('uses the bridge event endpoint for network capture', async () => {
    const records: RequestRecord[] = [];
    installFetchMock(records);
    const client = new WebviewCDPClient('chat-session');
    await client.connect();

    await expect(client.startNetworkCapture('/api')).resolves.toBe(true);
    await expect(client.readNetworkCapture()).resolves.toEqual([
      { url: 'https://example.com/api', method: 'GET' },
    ]);
    expect(records.some((request) => request.url.endsWith('/webview-network-start'))).toBe(true);
    expect(records.some((request) => request.url.endsWith('/webview-network-read'))).toBe(true);
  });

  it('marks parallel investigation commands as background work', async () => {
    const records: RequestRecord[] = [];
    installFetchMock(records);
    const client = new WebviewCDPClient('parallel-session', { background: true });
    await client.connect();

    await client.cdp('Page.enable');
    const pageEnable = records.find((request) => request.body.method === 'Page.enable');
    expect(pageEnable?.body.background).toBe(true);
  });

  it('uses all four box-model points for selector screenshots', async () => {
    const records: RequestRecord[] = [];
    installFetchMock(records);
    const client = new WebviewCDPClient('chat-session');
    await client.connect();

    await expect(client.screenshot({ selector: '#target' })).resolves.toBe('PNG_BASE64');
    const screenshot = records.find((request) => request.body.method === 'Page.captureScreenshot');
    expect(screenshot?.body.params).toEqual({
      format: 'png',
      clip: { x: 10, y: 20, width: 60, height: 40, scale: 1 },
    });
  });

  it('drives hover through native mouse movement', async () => {
    const records: RequestRecord[] = [];
    installFetchMock(records);
    const client = new WebviewCDPClient('chat-session');
    await client.connect();

    await client.hover('#target');
    const hover = records.find((request) => request.body.method === 'Input.dispatchMouseEvent');
    expect(hover?.body.params).toEqual({ type: 'mouseMoved', x: 40, y: 40 });
    expect(records.some((request) => request.body.method === 'Runtime.evaluate')).toBe(false);
  });

  it('uses DOM coordinates and native input for click and type', async () => {
    const records: RequestRecord[] = [];
    installFetchMock(records);
    const client = new WebviewCDPClient('chat-session');
    await client.connect();

    await client.click('#target');
    await client.type('#target', '你好');

    const inputs = records.filter((request) => request.body.method?.startsWith('Input.'));
    expect(inputs.map((request) => request.body.method)).toEqual([
      'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent',
      'Input.insertText',
    ]);
    expect(inputs.at(-1)?.body.params).toEqual({ text: '你好' });
    expect(records.some((request) => request.body.method === 'Runtime.evaluate')).toBe(false);
  });

  it('indexes only child frames and evaluates in the selected frame', async () => {
    const records: RequestRecord[] = [];
    installFetchMock(records);
    const client = new WebviewCDPClient('chat-session');
    await client.connect();

    await expect(client.frames()).resolves.toEqual([
      { index: 0, frameId: 'child-a', url: 'https://a.example', name: 'first' },
      { index: 1, frameId: 'child-b', url: 'https://b.example', name: 'second' },
    ]);
    await expect(client.evaluateInFrame('document.title', 0)).resolves.toBe('frame-result');
    const world = records.find((request) => request.body.method === 'Page.createIsolatedWorld');
    expect(world?.body.params).toMatchObject({ frameId: 'child-a' });
  });
});
