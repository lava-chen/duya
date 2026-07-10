/**
 * WebviewCDPClient - CDP Client backed by Electron <webview> webContents.debugger
 *
 * Data flow:
 *   Agent -> HTTP POST /webview-command -> Daemon -> IPC -> Renderer -> webContents.debugger.sendCommand
 *
 * Unlike ExtensionCDPClient (which sends high-level actions like 'click', 'type'),
 * this client sends raw CDP methods (Input.dispatchMouseEvent, Runtime.evaluate, etc.)
 * because the webview's debugger speaks pure CDP, not the extension's action protocol.
 *
 * Error semantics:
 *   - 404 with WEBVIEW_SESSION_NOT_REGISTERED: webview not ready yet, retry up to 10s
 *   - DEBUGGER_CONFLICT error code: user has DevTools open, do not retry (throw DebuggerConflict)
 */

import { EventEmitter } from 'events';
import type { ICDPClient, CDPResponse, CDPMode, TabInfo, BrowserCookie } from './CDPClient.js';

const DAEMON_PORT = parseInt(process.env.DUYA_DAEMON_PORT ?? '19825', 10);
const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;
const DUYA_HEADERS = { 'X-DUYA': '1' };

let _webviewIdCounter = 0;
function generateId(): string {
  return `wvcmd_${process.pid}_${Date.now()}_${++_webviewIdCounter}`;
}

/** Thrown when the webview's debugger cannot attach (e.g. DevTools is open). */
export class DebuggerConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DebuggerConflict';
  }
}

/** Thrown when the webview did not register within the retry window. */
export class WebviewNotReady extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebviewNotReady';
  }
}

export class WebviewCDPClient extends EventEmitter implements ICDPClient {
  private sessionId: string;
  private connected = false;
  private lastUrl = '';
  private lastTitle = '';

  constructor(sessionId: string) {
    super();
    this.sessionId = sessionId;
  }

  async connect(): Promise<void> {
    // Connection is lazy — actual attach happens on first sendCommand.
    // Here we just verify the daemon is reachable.
    try {
      const res = await this.requestDaemon('/ping', { timeout: 2000 });
      if (!res.ok) {
        throw new Error('Browser Daemon not available');
      }
      this.connected = true;
      this.emit('connected');
    } catch (err) {
      throw new Error(
        `WebviewCDPClient connect failed: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  async health(): Promise<{ status: string; mode: CDPMode }> {
    try {
      const res = await this.requestDaemon('/ping', { timeout: 500 });
      if (!res.ok) return { status: 'unavailable', mode: 'webview' };
      const data = await res.json() as { ok: boolean };
      return { status: data.ok ? 'ok' : 'unavailable', mode: 'webview' };
    } catch {
      return { status: 'unavailable', mode: 'webview' };
    }
  }

  async navigate(url: string): Promise<void> {
    if (!this.connected) await this.connect();
    // Enable Page domain to receive load events
    await this.send('Page.enable');
    await this.send('Page.navigate', { url });
    this.lastUrl = url;
    await this._waitForPageLoad();
  }

  private async _waitForPageLoad(timeoutMs = 10000): Promise<void> {
    const startTime = Date.now();
    let stableCount = 0;
    let lastReadyState = '';

    while (Date.now() - startTime < timeoutMs) {
      try {
        const readyState = await this.evaluate('document.readyState') as string;
        if (readyState === lastReadyState && readyState === 'complete') {
          stableCount++;
          if (stableCount >= 2) return;
        } else {
          stableCount = 0;
          lastReadyState = readyState || '';
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.connected) throw new Error('WebviewCDPClient not connected');

    const response = await this.sendCommand({ method, params }) as CDPResponse;

    if (response.error) {
      throw new Error(`CDP error: ${response.error.message} (code ${response.error.code})`);
    }

    return response.result;
  }

  async evaluate(expression: string, returnByValue = true): Promise<unknown> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue,
      awaitPromise: true,
    }) as { result?: { value?: unknown }; exceptionDetails?: { text: string } };

    if (result?.exceptionDetails) {
      throw new Error(`JS evaluation error: ${result.exceptionDetails.text}`);
    }
    return result?.result?.value;
  }

  async screenshot(options: { fullPage?: boolean; selector?: string } = {}): Promise<string> {
    const { fullPage = false, selector } = options;

    if (selector) {
      const docResult = await this.send('DOM.getDocument', {}) as { root?: { nodeId?: number } };
      const rootNodeId = docResult?.root?.nodeId;
      if (!rootNodeId) throw new Error('Could not get document root');

      const queryResult = await this.send('DOM.querySelector', { nodeId: rootNodeId, selector }) as { nodeId?: number };
      const nodeId = queryResult?.nodeId;
      if (!nodeId) throw new Error(`Element not found: ${selector}`);

      await this.send('DOM.scrollIntoViewIfNeeded', { nodeId }).catch(() => {});
      const boxResult = await this.send('DOM.getBoxModel', { nodeId }) as { model?: { content: number[] } };
      if (boxResult?.model?.content) {
        const [x1, y1, x2, y2] = boxResult.model.content;
        const clip = { x: Math.round(x1), y: Math.round(y1), width: Math.round(x2 - x1), height: Math.round(y2 - y1), scale: 1 };
        const screenshotResult = await this.send('Page.captureScreenshot', { format: 'png', clip }) as { data?: string };
        if (screenshotResult?.data) return screenshotResult.data;
      }
    }

    const params: Record<string, unknown> = { format: 'png' };
    if (fullPage) {
      const metrics = await this.send('Page.getLayoutMetrics', {}) as {
        contentSize?: { width: number; height: number };
        cssContentSize?: { width: number; height: number };
      };
      const size = metrics.cssContentSize || metrics.contentSize;
      if (size) {
        await this.send('Emulation.setDeviceMetricsOverride', {
          mobile: false, width: Math.ceil(size.width), height: Math.ceil(size.height), deviceScaleFactor: 1,
        });
      }
    }

    try {
      const result = await this.send('Page.captureScreenshot', params) as { data?: string };
      if (result?.data) return result.data;
    } finally {
      if (fullPage) {
        await this.send('Emulation.clearDeviceMetricsOverride', {}).catch(() => {});
      }
    }

    throw new Error('Screenshot failed');
  }

  async click(selector: string): Promise<void> {
    const elSelector = this._resolveSelector(selector);
    // Try direct JS click first
    const clicked = await this.evaluate(`
      (() => {
        const el = document.querySelector('${elSelector.replace(/'/g, "\\'")}');
        if (!el) return false;
        el.click();
        return true;
      })()
    `);
    if (clicked) return;

    // Coordinate-based fallback
    const box = await this.evaluate(`
      (() => {
        const el = document.querySelector('${elSelector.replace(/'/g, "\\'")}');
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()
    `) as { x: number; y: number } | null;

    if (!box) throw new Error(`Element not found: ${selector}`);

    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }

  async type(selector: string, text: string): Promise<void> {
    await this.click(selector);
    for (const char of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'char', text: char });
    }
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right' = 'down', amount = 300): Promise<void> {
    const deltaMap: Record<string, [number, number]> = {
      up: [0, -amount], down: [0, amount], left: [-amount, 0], right: [amount, 0],
    };
    const [deltaX, deltaY] = deltaMap[direction] || [0, amount];
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 0, y: 0, deltaX, deltaY });
  }

  async goBack(): Promise<void> {
    await this.evaluate('history.back()');
    await this.waitForLoad();
  }

  async pressKey(key: string): Promise<void> {
    const keyMap: Record<string, Record<string, unknown>> = {
      Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
      Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
      Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
      ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
      ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
      ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
      ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    };
    const keyInfo = keyMap[key] || { key, code: key, keyCode: 0 };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...keyInfo });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyInfo });
  }

  async getUrl(): Promise<string> {
    if (this.lastUrl) return this.lastUrl;
    try {
      const url = await this.evaluate('window.location.href') as string;
      this.lastUrl = url;
      return url;
    } catch {
      return this.lastUrl || 'about:blank';
    }
  }

  async getTitle(): Promise<string> {
    if (this.lastTitle) return this.lastTitle;
    try {
      const title = await this.evaluate('document.title') as string;
      this.lastTitle = title;
      return title;
    } catch {
      return this.lastTitle || '';
    }
  }

  async close(): Promise<void> {
    // Detach debugger is handled by renderer when webview unmounts.
    // Here we just reset state.
    this.connected = false;
    this.lastUrl = '';
    this.lastTitle = '';
    this.emit('closed');
  }

  async closeWindow(): Promise<void> {
    // No-op for webview mode — the webview stays in the panel.
    // Closing the tab is a user action handled by the panel.
  }

  async waitForLoad(_timeout = 30000): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  async hover(selector: string): Promise<void> {
    const elSelector = this._resolveSelector(selector);
    await this.evaluate(`
      (() => {
        const el = document.querySelector('${elSelector.replace(/'/g, "\\'")}');
        if (!el) throw new Error('Element not found: ${elSelector}');
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, cancelable: true }));
      })()
    `);
  }

  async waitForElement(selector: string, timeoutMs = 15000): Promise<void> {
    const elSelector = this._resolveSelector(selector);
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      try {
        const found = await this.evaluate(`document.querySelector('${elSelector.replace(/'/g, "\\'")}') !== null`);
        if (found) return;
      } catch { /* retry */ }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`Timeout waiting for element: ${selector}`);
  }

  async selectOption(selector: string, value: string): Promise<void> {
    const elSelector = this._resolveSelector(selector);
    await this.evaluate(`
      (() => {
        const e = document.querySelector('${elSelector.replace(/'/g, "\\'")}');
        if (!e) throw new Error('Element not found');
        e.value = '${value.replace(/'/g, "\\'")}';
        e.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
  }

  // --- Tab Management (webview is single-tab) ---

  async tabs(): Promise<TabInfo[]> {
    return [{ id: 0, url: await this.getUrl(), title: await this.getTitle(), active: true }];
  }

  async newTab(_url?: string): Promise<string | undefined> {
    // Webview mode is single-tab; newTab is not supported.
    return undefined;
  }

  async closeTab(_target?: number | string): Promise<void> {
    // No-op — tab closing is handled by panel UI
  }

  async selectTab(_target: number | string): Promise<void> {
    // No-op — single tab
  }

  // --- File Upload ---

  async setFileInput(files: string[], selector?: string): Promise<void> {
    if (!selector) throw new Error('Selector is required for setFileInput in webview mode');
    const elSelector = this._resolveSelector(selector);
    const docResult = await this.send('DOM.getDocument', {}) as { root?: { nodeId?: number } };
    const rootNodeId = docResult?.root?.nodeId;
    if (!rootNodeId) throw new Error('Could not get document root');
    const queryResult = await this.send('DOM.querySelector', { nodeId: rootNodeId, selector: elSelector }) as { nodeId?: number };
    if (queryResult?.nodeId) {
      await this.send('DOM.setFileInputFiles', { nodeId: queryResult.nodeId, files });
    }
  }

  // --- Network Capture ---

  async startNetworkCapture(_pattern: string = ''): Promise<boolean> {
    // Network capture requires Network.enable + event listening, which the
    // current sendCommand pattern doesn't support (it's request-response only).
    return false;
  }

  async readNetworkCapture(): Promise<unknown[]> {
    return [];
  }

  // --- Cookies ---

  async getCookies(opts: { domain?: string; url?: string } = {}): Promise<BrowserCookie[]> {
    const params: Record<string, unknown> = {};
    if (opts.url) params.urls = [opts.url];
    else if (opts.domain) params.urls = [`https://${opts.domain}`, `http://${opts.domain}`];

    const result = await this.send('Network.getCookies', params) as { cookies?: BrowserCookie[] };
    return Array.isArray(result?.cookies) ? result.cookies : [];
  }

  // --- Iframe Support ---

  async frames(): Promise<Array<{ index: number; frameId: string; url: string; name: string }>> {
    const tree = await this.send('Page.getFrameTree', {}) as {
      frameTree?: { frame?: { id: string; url: string; name?: string }; childFrames?: unknown[] }
    };
    const mainFrame = tree?.frameTree?.frame;
    if (!mainFrame) return [];
    return [{ index: 0, frameId: mainFrame.id, url: mainFrame.url, name: mainFrame.name || '' }];
  }

  async evaluateInFrame(js: string, _frameIndex: number): Promise<unknown> {
    // For v1, only support main frame (index 0)
    return this.evaluate(js);
  }

  // --- Raw CDP ---

  async cdp(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.send(method, params);
  }

  // --- Private Helpers ---

  private _resolveSelector(selector: string): string {
    if (selector.startsWith('@')) {
      return `[data-duya-ref="${selector.slice(1)}"]`;
    }
    return selector;
  }

  /**
   * Send a CDP command to the daemon's /webview-command endpoint.
   * Retries on 404 (webview not yet registered) up to 10 seconds.
   * Throws DebuggerConflict immediately if the renderer reports DevTools is open.
   */
  private async sendCommand(command: { method: string; params: Record<string, unknown> }): Promise<CDPResponse> {
    const id = generateId();
    const body = { id, sessionId: this.sessionId, ...command };

    const maxRetries = 20;
    const retryDelayMs = 500;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const res = await this.requestDaemon('/webview-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeout: 120000,
      });

      if (res.status === 404) {
        // Webview not ready yet — wait and retry
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        continue;
      }

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Daemon /webview-command error (${res.status}): ${errorText}`);
      }

      const json = await res.json() as CDPResponse & { ok?: boolean; error?: string };

      // Detect debugger conflict (DevTools open) — do not retry
      if (json.error === 'DEBUGGER_CONFLICT') {
        throw new DebuggerConflict(
          'Cannot attach webview debugger: DevTools is open. Please close DevTools and retry.'
        );
      }

      // Non-OK response from the daemon (e.g. webContents destroyed)
      if (json.ok === false) {
        throw new Error(`Webview CDP error: ${json.error ?? 'unknown error'}`);
      }

      return json;
    }

    throw new WebviewNotReady(
      `WebviewCDPClient: webview not ready after ${(maxRetries * retryDelayMs) / 1000}s timeout`
    );
  }

  private async requestDaemon(pathname: string, init?: RequestInit & { timeout?: number }): Promise<Response> {
    const { timeout = 2000, headers, ...rest } = init ?? {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      return await fetch(`${DAEMON_URL}${pathname}`, {
        ...rest,
        headers: { ...DUYA_HEADERS, ...(headers || {}) },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
