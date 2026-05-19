/**
 * DUYA Browser Bridge - Background Service Worker
 * WebSocket client connecting to Browser Daemon
 * Receives commands from Agent Process via Daemon
 *
 * Features:
 * - Automation window isolation: all operations happen in a dedicated Chrome window
 *   so the user's active browsing session is never touched.
 * - The automation window auto-closes after idle timeout.
 */

const DAEMON_URL = 'ws://127.0.0.1:19825/ext';
const RECONNECT_INTERVAL = 5000;
const MAX_RECONNECT_ATTEMPTS = 10;

/** @type {WebSocket | null} */
let ws = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let isConnecting = false;

/** @type {Map<string, chrome.debugger.Debuggee>} */
const attachedTabs = new Map();

// ─── Automation Window Isolation ─────────────────────────────────────
// All DUYA operations happen in a dedicated Chrome window so the
// user's active browsing session is never touched.
// Each agent session gets its own tab for independent parallel operation.

/** @type {number | null} */
let automationWindowId = null;
const IDLE_TIMEOUT = 60000; // 60s idle timeout

/**
 * @typedef {{ tabId: number; idleTimer: ReturnType<typeof setTimeout> | null }} SessionState
 */

/** @type {Map<string, SessionState>} */
const sessionTabs = new Map();

/**
 * Get or create a tab for the given session.
 * Each session gets its own independent tab in the automation window.
 */
async function getOrCreateSessionTab(sessionId) {
  if (!sessionId) {
    throw new Error('Missing sessionId');
  }

  // Return existing tab for this session
  const existing = sessionTabs.get(sessionId);
  if (existing) {
    try {
      await chrome.tabs.get(existing.tabId);
      resetSessionIdleTimer(sessionId);
      return existing.tabId;
    } catch {
      // Tab was closed externally, clean up and recreate
      sessionTabs.delete(sessionId);
      attachedTabs.delete(String(existing.tabId));
    }
  }

  // Ensure automation window exists
  const windowId = await getOrCreateAutomationWindow();
  if (!windowId) {
    throw new Error('Failed to create automation window');
  }

  // Create a new tab for this session
  const tab = await chrome.tabs.create({
    windowId,
    url: 'about:blank',
    active: false,
  });

  const tabId = tab.id;
  if (!tabId) {
    throw new Error('Failed to create session tab: no tab id');
  }

  sessionTabs.set(sessionId, { tabId, idleTimer: null });

  console.log(`[DUYA Bridge] Created session tab ${tabId} for session "${sessionId}"`);

  // Wait for initial tab load
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 500);
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });

  resetSessionIdleTimer(sessionId);
  return tabId;
}

/**
 * Get or create the shared automation window.
 * All session tabs live inside this single window.
 */
async function getOrCreateAutomationWindow() {
  if (automationWindowId) {
    try {
      await chrome.windows.get(automationWindowId);
      return automationWindowId;
    } catch {
      automationWindowId = null;
    }
  }

  const win = await chrome.windows.create({
    url: 'about:blank',
    focused: false,
    width: 1280,
    height: 900,
    type: 'normal',
  });

  automationWindowId = win.id;
  console.log(`[DUYA Bridge] Created automation window ${win.id}`);
  return win.id;
}

/**
 * Reset idle timer for a specific session tab.
 * When timer fires, only that session's tab is closed.
 */
function resetSessionIdleTimer(sessionId) {
  const session = sessionTabs.get(sessionId);
  if (!session) return;

  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
  }

  session.idleTimer = setTimeout(() => {
    closeSessionTab(sessionId);
  }, IDLE_TIMEOUT);
}

/**
 * Close a specific session tab and clean up its debugger attachment.
 * If no sessions remain, close the automation window.
 */
async function closeSessionTab(sessionId) {
  const session = sessionTabs.get(sessionId);
  if (!session) return;

  const { tabId } = session;

  // Clean up timer
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
  }

  // Detach debugger
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // May not be attached
  }
  attachedTabs.delete(String(tabId));

  // Close the tab
  try {
    await chrome.tabs.remove(tabId);
    console.log(`[DUYA Bridge] Session tab ${tabId} closed for session "${sessionId}"`);
  } catch {
    // Already gone
  }

  sessionTabs.delete(sessionId);

  // Close automation window if no sessions remain
  if (sessionTabs.size === 0 && automationWindowId) {
    try {
      await chrome.windows.remove(automationWindowId);
      console.log(`[DUYA Bridge] Automation window ${automationWindowId} closed (all sessions ended)`);
    } catch {
      // Already gone
    }
    automationWindowId = null;
  }
}

/**
 * Validate that a tabId belongs to a session.
 */
function validateTabOwnership(tabId, sessionId) {
  if (!sessionId || !tabId) return false;

  const session = sessionTabs.get(sessionId);
  if (!session) return false;
  if (session.tabId !== tabId) return false;

  resetSessionIdleTimer(sessionId);
  return true;
}

// Clean up when a session tab is closed externally (e.g. user closes it)
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [sessionId, session] of sessionTabs) {
    if (session.tabId === tabId) {
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
      }
      attachedTabs.delete(String(tabId));
      sessionTabs.delete(sessionId);
      console.log(`[DUYA Bridge] Session tab ${tabId} removed externally for session "${sessionId}"`);
      break;
    }
  }
});

// Clean up when the automation window is closed by user
chrome.windows.onRemoved.addListener((windowId) => {
  if (automationWindowId === windowId) {
    // Clean up all session tabs
    for (const [sessionId, session] of sessionTabs) {
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
      }
      attachedTabs.delete(String(session.tabId));
    }
    sessionTabs.clear();
    automationWindowId = null;
    console.log('[DUYA Bridge] Automation window closed by user, all sessions cleaned up');
  }
});

// ─── WebSocket Connection ────────────────────────────────────────────

function connect() {
  if (isConnecting || (ws && ws.readyState === WebSocket.OPEN)) return;
  isConnecting = true;

  try {
    ws = new WebSocket(DAEMON_URL);

    ws.onopen = async () => {
      console.log('[DUYA Bridge] Connected to daemon');
      reconnectAttempts = 0;
      isConnecting = false;

      // Send hello message with name and version
      const manifest = chrome.runtime.getManifest();
      sendMessage({
        type: 'hello',
        name: manifest.name,
        version: manifest.version,
        compatRange: '^1.0.0',
      });

      // Send blocked domains to daemon
      const blockedDomains = await getBlockedDomains();
      sendMessage({
        type: 'blocked_domains',
        domains: blockedDomains,
      });

      // Send connection log to daemon
      sendMessage({
        type: 'log',
        level: 'info',
        msg: 'Connected to daemon',
      });
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        await handleCommand(msg);
      } catch (error) {
        console.error('[DUYA Bridge] Error handling message:', error);
        sendResult(msg.id, { ok: false, error: error.message });
      }
    };

    ws.onclose = () => {
      console.log('[DUYA Bridge] Disconnected from daemon');
      ws = null;
      isConnecting = false;
      scheduleReconnect();
    };

    ws.onerror = (error) => {
      console.error('[DUYA Bridge] WebSocket error:', error);
      isConnecting = false;
    };
  } catch (error) {
    console.error('[DUYA Bridge] Failed to connect:', error);
    isConnecting = false;
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.log('[DUYA Bridge] Max reconnect attempts reached');
    return;
  }

  reconnectAttempts++;
  console.log(`[DUYA Bridge] Reconnecting in ${RECONNECT_INTERVAL}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect(), RECONNECT_INTERVAL);
}

function sendMessage(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendResult(id, result) {
  sendMessage({ id, ...result });
}

// ─── Command Handler ─────────────────────────────────────────────────

async function handleCommand(msg) {
  const { id, action, sessionId, tabId } = msg;

  // Validate tab ownership for commands that specify both sessionId and tabId
  // (skip navigate, close_window, close_session, and tabs which manage tabs themselves)
  if (sessionId && tabId &&
      action !== 'navigate' &&
      action !== 'close_window' &&
      action !== 'close_session' &&
      action !== 'tabs') {
    if (!validateTabOwnership(tabId, sessionId)) {
      sendResult(id, {
        ok: false,
        error: `Tab ${tabId} does not belong to session "${sessionId}"`,
      });
      return;
    }
  }

  try {
    switch (action) {
      case 'cdp':
        await handleCDP(id, msg);
        break;

      case 'navigate':
        await handleNavigate(id, msg);
        break;

      case 'tabs':
        await handleTabs(id);
        break;

      case 'screenshot':
        await handleScreenshot(id, msg);
        break;

      case 'evaluate':
        await handleEvaluate(id, msg);
        break;

      case 'click':
        await handleClick(id, msg);
        break;

      case 'type':
        await handleType(id, msg);
        break;

      case 'scroll':
        await handleScroll(id, msg);
        break;

      case 'go_back':
        await handleGoBack(id, msg);
        break;

      case 'press_key':
        await handlePressKey(id, msg);
        break;

      case 'close_window':
        await handleCloseWindow(id, msg);
        break;

      case 'close_session':
        await closeSessionTab(msg.sessionId);
        sendResult(id, { ok: true });
        break;

      default:
        sendResult(id, { ok: false, error: `Unknown action: ${action}` });
    }
  } catch (error) {
    sendResult(id, { ok: false, error: error.message });
  }
}

// ─── CDP Command ─────────────────────────────────────────────────────

async function handleCDP(id, msg) {
  const { tabId, method, params = {} } = msg;

  if (!tabId) {
    sendResult(id, { ok: false, error: 'Missing tabId for CDP command' });
    return;
  }

  const debuggee = await getOrAttachTab(tabId);

  try {
    const result = await chrome.debugger.sendCommand(debuggee, method, params);
    sendResult(id, { ok: true, data: result });
  } catch (error) {
    // If command fails due to detached debugger, try once more after re-attaching
    if (error.message?.includes('not attached') || error.message?.includes('Detached')) {
      try {
        attachedTabs.delete(String(tabId));
        const newDebuggee = await attachTab(tabId);
        const result = await chrome.debugger.sendCommand(newDebuggee, method, params);
        sendResult(id, { ok: true, data: result });
        return;
      } catch (retryError) {
        sendResult(id, { ok: false, error: retryError.message });
        return;
      }
    }
    sendResult(id, { ok: false, error: error.message });
  }
}

// ─── Domain Blocking ─────────────────────────────────────────────────

const BLOCKED_DOMAINS_KEY = 'duyaBlockedDomains';

/**
 * Get blocked domains from storage
 */
async function getBlockedDomains() {
  try {
    const result = await chrome.storage.local.get(BLOCKED_DOMAINS_KEY);
    return result[BLOCKED_DOMAINS_KEY] || [];
  } catch {
    return [];
  }
}

/**
 * Check if a URL is blocked
 */
async function isUrlBlocked(url) {
  try {
    const blockedDomains = await getBlockedDomains();
    if (blockedDomains.length === 0) return false;

    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();

    for (const blocked of blockedDomains) {
      // Exact match
      if (hostname === blocked) return true;

      // Subdomain match (e.g., blocked: example.com, url: www.example.com)
      if (hostname.endsWith('.' + blocked)) return true;

      // Wildcard match (e.g., blocked: *.example.com)
      if (blocked.startsWith('*.')) {
        const domain = blocked.slice(2);
        if (hostname === domain || hostname.endsWith('.' + domain)) return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

// ─── Navigation ──────────────────────────────────────────────────────

async function handleNavigate(id, msg) {
  const { url, sessionId } = msg;

  if (!url) {
    sendResult(id, { ok: false, error: 'Missing url' });
    return;
  }

  // Check if URL is blocked
  if (await isUrlBlocked(url)) {
    console.warn(`[DUYA Bridge] Navigation blocked: ${url}`);
    sendResult(id, { ok: false, error: `Navigation blocked: This domain is in the blocklist` });
    return;
  }

  // Get or create tab for this session
  const targetTabId = await getOrCreateSessionTab(sessionId);

  // Navigate in the session tab
  await chrome.tabs.update(targetTabId, { url });

  // Wait for navigation to complete
  let timedOut = false;
  await new Promise((resolve) => {
    let settled = false;
    let timeoutTimer = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve();
    };

    const listener = (updatedTabId, info) => {
      if (updatedTabId !== targetTabId) return;
      if (info.status === 'complete') {
        finish();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    // Timeout fallback
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      console.warn(`[DUYA Bridge] Navigate to ${url} timed out after 15s`);
      finish();
    }, 15000);
  });

  // Re-attach debugger after navigation
  await new Promise(r => setTimeout(r, 500));
  try {
    await attachTab(targetTabId);
  } catch (error) {
    console.warn(`[DUYA Bridge] Re-attach after navigation failed: ${error.message}`);
  }

  const finalTab = await chrome.tabs.get(targetTabId);
  sendResult(id, {
    ok: true,
    data: {
      tabId: targetTabId,
      url: finalTab.url,
      title: finalTab.title,
      timedOut,
    }
  });
}

// ─── Tabs ────────────────────────────────────────────────────────────

async function handleTabs(id) {
  // Only list tabs in the automation window that belong to active sessions
  if (automationWindowId && sessionTabs.size > 0) {
    try {
      const tabs = await chrome.tabs.query({ windowId: automationWindowId });
      const sessionTabIds = new Set(
        Array.from(sessionTabs.values()).map(s => s.tabId)
      );
      sendResult(id, {
        ok: true,
        data: tabs
          .filter(t => sessionTabIds.has(t.id))
          .map(t => ({
            id: t.id,
            url: t.url,
            title: t.title,
            active: t.active,
          })),
      });
      return;
    } catch {
      // Window closed, fall through to empty list
    }
  }
  sendResult(id, { ok: true, data: [] });
}

// ─── Screenshot ──────────────────────────────────────────────────────

async function handleScreenshot(id, msg) {
  const { tabId, fullPage = false } = msg;

  if (!tabId) {
    sendResult(id, { ok: false, error: 'Missing tabId' });
    return;
  }

  const debuggee = await getOrAttachTab(tabId);

  // Helper with 8s timeout to prevent hanging
  const withTimeout = (promise, ms = 8000) =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Screenshot timeout')), ms)),
    ]);

  try {
    if (fullPage) {
      const metrics = await withTimeout(chrome.debugger.sendCommand(debuggee, 'Page.getLayoutMetrics', {}));
      await withTimeout(chrome.debugger.sendCommand(debuggee, 'Emulation.setDeviceMetricsOverride', {
        width: metrics.contentSize.width,
        height: metrics.contentSize.height,
        deviceScaleFactor: 1,
        mobile: false,
      }));

      const result = await withTimeout(chrome.debugger.sendCommand(debuggee, 'Page.captureScreenshot', { format: 'png' }));
      chrome.debugger.sendCommand(debuggee, 'Emulation.clearDeviceMetricsOverride', {}).catch(() => {});

      sendResult(id, { ok: true, data: result });
    } else {
      const result = await withTimeout(chrome.debugger.sendCommand(debuggee, 'Page.captureScreenshot', { format: 'png' }));
      sendResult(id, { ok: true, data: result });
    }
  } catch (error) {
    sendResult(id, { ok: false, error: error.message });
  }
}

// ─── Evaluate ────────────────────────────────────────────────────────

async function handleEvaluate(id, msg) {
  const { tabId, script } = msg;
  const debuggee = await getOrAttachTab(tabId);

  try {
    const result = await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
      awaitPromise: true,
    });

    if (result.exceptionDetails) {
      sendResult(id, { ok: false, error: result.exceptionDetails.text });
    } else {
      sendResult(id, { ok: true, data: result.result?.value });
    }
  } catch (error) {
    sendResult(id, { ok: false, error: error.message });
  }
}

// ─── Click ───────────────────────────────────────────────────────────

async function handleClick(id, msg) {
  const { tabId, selector } = msg;

  if (!selector) {
    sendResult(id, { ok: false, error: 'Missing selector' });
    return;
  }

  const debuggee = await getOrAttachTab(tabId);

  try {
    if (selector.startsWith('@')) {
      // Ref-based clicking
      const ref = selector.slice(1);
      await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
        expression: `document.querySelector('[data-duya-ref="${ref}"]')?.click()`,
      });
    } else {
      // Selector-based clicking: get document root first, then query
      const doc = await chrome.debugger.sendCommand(debuggee, 'DOM.getDocument', {});
      const rootNodeId = doc.root.nodeId;
      const result = await chrome.debugger.sendCommand(debuggee, 'DOM.querySelector', { nodeId: rootNodeId, selector });
      const nodeId = result.nodeId;

      if (!nodeId) {
        sendResult(id, { ok: false, error: `Element not found: ${selector}` });
        return;
      }

      const boxResult = await chrome.debugger.sendCommand(debuggee, 'DOM.getBoxModel', { nodeId });
      const [x1, y1, x2, y2] = boxResult.model.content;
      const x = (x1 + x2) / 2;
      const y = (y1 + y2) / 2;

      await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', clickCount: 1,
      });
      await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
      });
    }

    sendResult(id, { ok: true });
  } catch (error) {
    sendResult(id, { ok: false, error: error.message });
  }
}

// ─── Type ────────────────────────────────────────────────────────────

async function handleType(id, msg) {
  const { tabId, selector, text } = msg;

  if (!selector) {
    sendResult(id, { ok: false, error: 'Missing selector' });
    return;
  }
  if (typeof text !== 'string') {
    sendResult(id, { ok: false, error: 'Missing text' });
    return;
  }

  const debuggee = await getOrAttachTab(tabId);

  try {
    // Focus element by clicking it (internal, does not sendResult)
    if (selector.startsWith('@')) {
      const ref = selector.slice(1);
      await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
        expression: `document.querySelector('[data-duya-ref="${ref}"]')?.focus()`,
      });
    } else {
      const doc = await chrome.debugger.sendCommand(debuggee, 'DOM.getDocument', {});
      const rootNodeId = doc.root.nodeId;
      const result = await chrome.debugger.sendCommand(debuggee, 'DOM.querySelector', { nodeId: rootNodeId, selector });
      if (result.nodeId) {
        const boxResult = await chrome.debugger.sendCommand(debuggee, 'DOM.getBoxModel', { nodeId: result.nodeId });
        const [x1, y1, x2, y2] = boxResult.model.content;
        const x = (x1 + x2) / 2;
        const y = (y1 + y2) / 2;
        await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x, y, button: 'left', clickCount: 1,
        });
        await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
        });
      }
    }

    // Type text
    for (const char of text) {
      await chrome.debugger.sendCommand(debuggee, 'Input.dispatchKeyEvent', {
        type: 'char', text: char,
      });
    }

    sendResult(id, { ok: true });
  } catch (error) {
    sendResult(id, { ok: false, error: error.message });
  }
}

// ─── Scroll ──────────────────────────────────────────────────────────

async function handleScroll(id, msg) {
  const { tabId, direction = 'down', amount = 300 } = msg;
  const debuggee = await getOrAttachTab(tabId);

  const scrollMap = {
    up: [0, -amount],
    down: [0, amount],
    left: [-amount, 0],
    right: [amount, 0],
  };

  const [deltaX, deltaY] = scrollMap[direction] || [0, amount];

  try {
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: 0, y: 0, deltaX, deltaY,
    });
    sendResult(id, { ok: true });
  } catch (error) {
    sendResult(id, { ok: false, error: error.message });
  }
}

// ─── Go Back ─────────────────────────────────────────────────────────

async function handleGoBack(id, msg) {
  const { tabId } = msg;
  const debuggee = await getOrAttachTab(tabId);

  try {
    await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
      expression: 'history.back()',
    });
    sendResult(id, { ok: true });
  } catch (error) {
    sendResult(id, { ok: false, error: error.message });
  }
}

// ─── Press Key ───────────────────────────────────────────────────────

async function handlePressKey(id, msg) {
  const { tabId, key } = msg;
  const debuggee = await getOrAttachTab(tabId);

  const keyMap = {
    Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
    Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  };

  const keyInfo = keyMap[key] || { key, code: key, keyCode: 0 };

  try {
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchKeyEvent', {
      type: 'keyDown', ...keyInfo,
    });
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchKeyEvent', {
      type: 'keyUp', ...keyInfo,
    });
    sendResult(id, { ok: true });
  } catch (error) {
    sendResult(id, { ok: false, error: error.message });
  }
}

// ─── Close Window ────────────────────────────────────────────────────

async function handleCloseWindow(id, msg) {
  const { sessionId } = msg;
  if (sessionId) {
    await closeSessionTab(sessionId);
  } else {
    // Close all sessions (backward compat)
    for (const sid of Array.from(sessionTabs.keys())) {
      await closeSessionTab(sid);
    }
  }
  sendResult(id, { ok: true });
}

// ─── Tab Management ──────────────────────────────────────────────────

let eventListenerSetup = false;

async function getOrAttachTab(tabId) {
  const key = String(tabId);

  if (attachedTabs.has(key)) {
    const debuggee = attachedTabs.get(key);
    // Verify the debugger is still attached by sending a simple command
    try {
      await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
        expression: '1',
        returnByValue: true,
      });
      return debuggee;
    } catch {
      // Debugger connection lost, reattach
      attachedTabs.delete(key);
    }
  }

  return await attachTab(tabId);
}

async function attachTab(tabId) {
  const key = String(tabId);
  const debuggee = { tabId };

  try {
    // Detach first if already attached (to handle re-attachment after navigation)
    if (attachedTabs.has(key)) {
      try {
        await chrome.debugger.detach(debuggee);
      } catch {
        // Ignore detach errors
      }
      attachedTabs.delete(key);
    }

    // Also try to detach any existing connection to this tab (Windows workaround)
    try {
      await chrome.debugger.detach(debuggee);
    } catch {
      // Ignore - may not have been attached
    }

    await chrome.debugger.attach(debuggee, '1.3');

    // Enable domains with small delay between each (Windows stability fix)
    await chrome.debugger.sendCommand(debuggee, 'Runtime.enable');
    await new Promise(r => setTimeout(r, 50));
    await chrome.debugger.sendCommand(debuggee, 'Page.enable');
    await new Promise(r => setTimeout(r, 50));
    await chrome.debugger.sendCommand(debuggee, 'DOM.enable');
    await new Promise(r => setTimeout(r, 50));
    await chrome.debugger.sendCommand(debuggee, 'Network.enable');
    await new Promise(r => setTimeout(r, 50));

    attachedTabs.set(key, debuggee);

    // Setup event listener (only once globally)
    if (!eventListenerSetup) {
      eventListenerSetup = true;
      chrome.debugger.onEvent.addListener((source, method, params) => {
        sendMessage({
          type: 'cdpEvent',
          tabId: source.tabId,
          method,
          params,
        });
      });
    }

    return debuggee;
  } catch (error) {
    attachedTabs.delete(key);
    throw new Error(`Failed to attach tab ${tabId}: ${error.message}`);
  }
}

// ─── Heartbeat ───────────────────────────────────────────────────────

function setupHeartbeat() {
  // Use chrome.alarms instead of setInterval because service workers
  // can be suspended between ticks. The alarm fires even when the
  // service worker is idle, waking it up to reconnect if needed.
  chrome.alarms.create('keepalive', { periodInMinutes: 0.17 }); // ~10s
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    void connect();
  }
});

// ─── Storage Change Listener ─────────────────────────────────────────

// Listen for blocked domains changes and notify daemon
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[BLOCKED_DOMAINS_KEY]) {
    const newDomains = changes[BLOCKED_DOMAINS_KEY].newValue || [];
    console.log('[DUYA Bridge] Blocked domains updated:', newDomains.length, 'domains');

    // Notify daemon of the change
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendMessage({
        type: 'blocked_domains',
        domains: newDomains,
      });
    }
  }
});

// ─── Initialize ──────────────────────────────────────────────────────

void connect();
setupHeartbeat();

chrome.runtime.onInstalled.addListener(() => {
  console.log('[DUYA Bridge] Extension installed');
  void connect();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[DUYA Bridge] Extension starting up');
  void connect();
});

// Allow external callers (e.g. daemon health check via extension popup) to trigger a reconnect
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'ping') {
    sendResponse({ ok: true, connected: ws?.readyState === WebSocket.OPEN });
  }
  if (msg?.type === 'connect') {
    void connect().then(() => sendResponse({ ok: true }));
    return true; // async response
  }
  return false;
});
