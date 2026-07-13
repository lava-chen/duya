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

interface FrameTree {
  frame?: { id: string; url: string; name?: string };
  childFrames?: FrameTree[];
}

export interface WebviewCDPClientOptions {
  /** Keep parallel investigation tabs from repeatedly stealing the sidebar focus. */
  background?: boolean;
}

export class WebviewCDPClient extends EventEmitter implements ICDPClient {
  private sessionId: string;
  private connected = false;
  private lastUrl = '';
  private lastTitle = '';
  private activeTabId = 'tab_0';
  private tabSequence = 0;
  private readonly tabState = new Map<string, { url: string; title: string }>([
    ['tab_0', { url: 'about:blank', title: '' }],
  ]);

  constructor(sessionId: string, private readonly options: WebviewCDPClientOptions = {}) {
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
    this.tabState.set(this.activeTabId, { url, title: '' });
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
      const contentQuad = boxResult?.model?.content;
      if (!contentQuad || contentQuad.length < 8) {
        throw new Error(`Element has no rendered box: ${selector}`);
      }
      const xValues = contentQuad.filter((_, index) => index % 2 === 0);
      const yValues = contentQuad.filter((_, index) => index % 2 === 1);
      const x = Math.floor(Math.min(...xValues));
      const y = Math.floor(Math.min(...yValues));
      const width = Math.ceil(Math.max(...xValues) - x);
      const height = Math.ceil(Math.max(...yValues) - y);
      if (width < 1 || height < 1) {
        throw new Error(`Element has no visible size: ${selector}. Select a visible child or omit selector for a page screenshot.`);
      }
      const clip = { x, y, width, height, scale: 1 };
      const screenshotResult = await this.send('Page.captureScreenshot', { format: 'png', clip }) as { data?: string };
      if (screenshotResult?.data) return screenshotResult.data;
      throw new Error(`Element screenshot failed: ${selector}`);
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
    const point = await this.getVisibleElementCenter(selector);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }

  async type(selector: string, text: string): Promise<void> {
    await this.click(selector);
    // Input.insertText preserves IME/unicode input and emits native input events.
    await this.send('Input.insertText', { text });
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
      const tab = this.tabState.get(this.activeTabId);
      if (tab) tab.url = url;
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
      const tab = this.tabState.get(this.activeTabId);
      if (tab) tab.title = title;
      return title;
    } catch {
      return this.lastTitle || '';
    }
  }

  async close(): Promise<void> {
    await this.closeWindow();
    this.connected = false;
    this.lastUrl = '';
    this.lastTitle = '';
    this.emit('closed');
  }

  async closeWindow(): Promise<void> {
    await Promise.all(Array.from(this.tabState.keys()).map((tabId) => this.closeWebviewTab(tabId)));
    this.tabState.clear();
  }

  async waitForLoad(_timeout = 30000): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  async hover(selector: string): Promise<void> {
    const point = await this.getVisibleElementCenter(selector);
    // Native input events do not surface exceptions thrown by page-level
    // mouse handlers, while still driving the browser's real hover state.
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
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
    await this.getVisibleElementCenter(selector);
    // Page-level input/change handlers may throw after the native value has
    // already changed. Keep that application exception from turning a valid
    // selection into a CDP evaluation failure.
    const expression = `(() => {
      const element = document.querySelector(${JSON.stringify(elSelector)});
      if (!(element instanceof HTMLSelectElement)) return { ok: false, error: 'Select element not found' };
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      if (setter) setter.call(element, ${JSON.stringify(value)});
      else element.value = ${JSON.stringify(value)};
      try { element.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
      try { element.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
      return { ok: true };
    })()`;
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      silent: true,
    }) as { result?: { value?: { ok?: boolean; error?: string } }; exceptionDetails?: { text?: string } };
    if (result.exceptionDetails) throw new Error(`JS evaluation error: ${result.exceptionDetails.text ?? 'Unknown error'}`);
    if (!result.result?.value?.ok) throw new Error(result.result?.value?.error ?? `Could not select option: ${value}`);
  }

  // --- Tab Management (webview is single-tab) ---

  async tabs(): Promise<TabInfo[]> {
    await Promise.all([this.getUrl(), this.getTitle()]);
    return Array.from(this.tabState.entries()).map(([id, tab]) => ({
      id,
      url: tab.url,
      title: tab.title,
      active: id === this.activeTabId,
    }));
  }

  async newTab(url?: string): Promise<string | undefined> {
    const tabId = `tab_${++this.tabSequence}`;
    this.tabState.set(tabId, { url: url ?? 'about:blank', title: '' });
    await this.sendForTab(tabId, 'Page.enable');
    if (url) await this.sendForTab(tabId, 'Page.navigate', { url });
    return tabId;
  }

  async closeTab(target?: number | string): Promise<void> {
    const tabId = this.resolveTabId(target);
    await this.closeWebviewTab(tabId);
    this.tabState.delete(tabId);
    if (this.activeTabId === tabId) {
      this.activeTabId = this.tabState.keys().next().value ?? 'tab_0';
      this.lastUrl = '';
      this.lastTitle = '';
    }
  }

  async selectTab(target: number | string): Promise<void> {
    const tabId = this.resolveTabId(target);
    this.activeTabId = tabId;
    const tab = this.tabState.get(tabId);
    this.lastUrl = tab?.url ?? '';
    this.lastTitle = tab?.title ?? '';
    await this.controlWebviewTab('/webview-activate', tabId);
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
      return;
    }
    throw new Error(`File input not found: ${selector}`);
  }

  // --- Network Capture ---

  async startNetworkCapture(pattern: string = ''): Promise<boolean> {
    const result = await this.postWebviewEndpoint('/webview-network-start', {
      sessionId: this.webviewSessionId(),
      pattern,
    });
    return result.ok === true;
  }

  async readNetworkCapture(): Promise<unknown[]> {
    const result = await this.postWebviewEndpoint('/webview-network-read', {
      sessionId: this.webviewSessionId(),
    });
    return Array.isArray(result.data) ? result.data : [];
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
      frameTree?: FrameTree
    };
    const frames: Array<{ index: number; frameId: string; url: string; name: string }> = [];
    const visit = (node: FrameTree | undefined) => {
      if (!node?.frame) return;
      frames.push({ index: frames.length, frameId: node.frame.id, url: node.frame.url, name: node.frame.name || '' });
      node.childFrames?.forEach(visit);
    };
    // `iframe_evaluate` indexes iframe documents, not the page's main frame.
    // Excluding the root makes index 0 stable and matches the tool contract.
    tree?.frameTree?.childFrames?.forEach(visit);
    return frames;
  }

  async evaluateInFrame(js: string, frameIndex: number): Promise<unknown> {
    const frame = (await this.frames())[frameIndex];
    if (!frame) throw new Error(`Frame not found: ${frameIndex}`);
    const world = await this.send('Page.createIsolatedWorld', {
      frameId: frame.frameId,
      worldName: `duya-browser-tool-${frame.frameId}-${Date.now()}`,
      grantUniveralAccess: false,
    }) as { executionContextId?: number };
    if (!world.executionContextId) throw new Error(`Could not create execution context for frame: ${frameIndex}`);
    const result = await this.send('Runtime.evaluate', {
      expression: js,
      contextId: world.executionContextId,
      returnByValue: true,
      awaitPromise: true,
    }) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
    if (result.exceptionDetails) throw new Error(`JS evaluation error: ${result.exceptionDetails.text ?? 'Unknown error'}`);
    return result.result?.value;
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

  private async getVisibleElementCenter(selector: string): Promise<{ x: number; y: number }> {
    const resolvedSelector = this._resolveSelector(selector);
    const documentResult = await this.send('DOM.getDocument', {}) as { root?: { nodeId?: number } };
    const rootNodeId = documentResult.root?.nodeId;
    if (!rootNodeId) throw new Error('Could not get document root');

    const queryResult = await this.send('DOM.querySelector', {
      nodeId: rootNodeId,
      selector: resolvedSelector,
    }) as { nodeId?: number };
    const nodeId = queryResult.nodeId;
    if (!nodeId) throw new Error(`Element not found: ${selector}`);

    await this.send('DOM.scrollIntoViewIfNeeded', { nodeId }).catch(() => {});
    const boxResult = await this.send('DOM.getBoxModel', { nodeId }) as { model?: { content?: number[] } };
    const contentQuad = boxResult.model?.content;
    if (!contentQuad || contentQuad.length < 8) throw new Error(`Element has no rendered box: ${selector}`);
    const xValues = contentQuad.filter((_, index) => index % 2 === 0);
    const yValues = contentQuad.filter((_, index) => index % 2 === 1);
    const minX = Math.min(...xValues);
    const maxX = Math.max(...xValues);
    const minY = Math.min(...yValues);
    const maxY = Math.max(...yValues);
    if (maxX - minX < 1 || maxY - minY < 1) throw new Error(`Element has no visible size: ${selector}`);
    return { x: minX + (maxX - minX) / 2, y: minY + (maxY - minY) / 2 };
  }

  private webviewSessionId(tabId = this.activeTabId): string {
    // Keep the default tab using the plain sessionId so the renderer's
    // AgentBrowserTab registration (which registers sessionId) continues
    // to match. Extra tabs use the namespaced form.
    return tabId === 'tab_0' ? this.sessionId : `${this.sessionId}::${tabId}`;
  }

  private resolveTabId(target?: number | string): string {
    if (target === undefined) return this.activeTabId;
    if (typeof target === 'string' && this.tabState.has(target)) return target;
    const index = typeof target === 'number' ? target : Number.parseInt(target, 10);
    const tabId = Array.from(this.tabState.keys())[index];
    if (!tabId) throw new Error(`Tab not found: ${String(target)}`);
    return tabId;
  }

  private async sendForTab(tabId: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const response = await this.sendCommand({ method, params }, tabId);
    if (response.error) throw new Error(`CDP error: ${response.error.message} (code ${response.error.code})`);
    return response.result;
  }

  private async postWebviewEndpoint(pathname: string, body: Record<string, unknown>): Promise<{ ok?: boolean; data?: unknown[]; error?: string }> {
    const response = await this.requestDaemon(pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: 15000,
    });
    if (!response.ok) throw new Error(`Webview endpoint failed (${response.status}): ${await response.text()}`);
    return response.json() as Promise<{ ok?: boolean; data?: unknown[]; error?: string }>;
  }

  private async controlWebviewTab(pathname: '/webview-close' | '/webview-activate', tabId: string): Promise<void> {
    const result = await this.postWebviewEndpoint(pathname, { sessionId: this.webviewSessionId(tabId) });
    if (result.ok !== true) throw new Error(result.error ?? 'Webview tab control failed');
  }

  private async closeWebviewTab(tabId: string): Promise<void> {
    try {
      await this.controlWebviewTab('/webview-close', tabId);
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('404')) throw err;
    }
  }

  /**
   * Send a CDP command to the daemon's /webview-command endpoint.
   * Retries on 404 (webview not yet registered) up to 10 seconds.
   * Throws DebuggerConflict immediately if the renderer reports DevTools is open.
   */
  private async sendCommand(command: { method: string; params: Record<string, unknown> }, tabId = this.activeTabId): Promise<CDPResponse> {
    const id = generateId();
    const body = {
      id,
      sessionId: this.webviewSessionId(tabId),
      ...(this.options.background ? { background: true } : {}),
      ...command,
    };

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
