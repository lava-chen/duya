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
let connectTimeoutTimer = null;
let connectPromise = null;
let helloSent = false;

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
  if (ws && ws.readyState === WebSocket.OPEN) {
    return Promise.resolve(sendHello(ws));
  }
  if (connectPromise) return connectPromise;

  isConnecting = true;

  connectPromise = new Promise((resolve) => {
    let settled = false;
    let waitingForAck = false;
    let ackTimeout = null;
    const socket = new WebSocket(DAEMON_URL);
    ws = socket;
    helloSent = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      waitingForAck = false;
      connectPromise = null;
      if (ackTimeout) { clearTimeout(ackTimeout); ackTimeout = null; }
      resolve(result);
    };

    const clearConnectTimeout = () => {
      if (connectTimeoutTimer) {
        clearTimeout(connectTimeoutTimer);
        connectTimeoutTimer = null;
      }
    };

    if (connectTimeoutTimer) clearTimeout(connectTimeoutTimer);
    connectTimeoutTimer = setTimeout(() => {
      if (ws === socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) && !settled) {
        console.warn('[DUYA Bridge] WebSocket connect timeout, forcing reconnect');
        try { socket.close(); } catch {}
        ws = null;
        isConnecting = false;
        if (ackTimeout) { clearTimeout(ackTimeout); ackTimeout = null; }
        finish({ ok: false, connected: false, phase: 'timeout' });
        scheduleReconnect();
      }
    }, 5000);

    socket.onopen = async () => {
      try {
        console.log('[DUYA Bridge] Connected to daemon');
        reconnectAttempts = 0;
        isConnecting = false;
        clearConnectTimeout();

        const helloResult = sendHello(socket);
        if (!helloResult.ok) {
          finish(helloResult);
          return;
        }

        // Wait for daemon hello_ack instead of resolving immediately
        waitingForAck = true;
        ackTimeout = setTimeout(() => {
          if (waitingForAck && !settled) {
            console.warn('[DUYA Bridge] No hello_ack received, closing');
            try { socket.close(); } catch {}
            finish({ ok: false, connected: false, phase: 'ack_timeout' });
          }
        }, 4000);
      } catch (error) {
        console.error('[DUYA Bridge] onopen handshake failed:', error);
        isConnecting = false;
        finish({ ok: false, connected: false, phase: 'handshake_failed', error: error?.message ?? String(error) });
        try { socket.close(); } catch {}
      }
    };

    socket.onmessage = async (event) => {
      let msg = null;
      try {
        msg = JSON.parse(event.data);

        // Intercept hello_ack during the handshake phase
        if (msg.type === 'hello_ack' && waitingForAck && !settled) {
          clearTimeout(ackTimeout);
          ackTimeout = null;

          if (msg.ok) {
            finish({ ok: true, connected: true, phase: 'verified' });
            // Send non-critical messages after connection is verified
            try {
              const blockedDomains = await getBlockedDomains();
              sendSocketMessage(socket, { type: 'blocked_domains', domains: blockedDomains });
            } catch {}
            sendSocketMessage(socket, { type: 'log', level: 'info', msg: 'Connected to daemon' });
          } else {
            finish({
              ok: false,
              connected: false,
              phase: msg.reason === 'pending_approval' ? 'pending_approval' : 'rejected',
              reason: msg.reason ?? 'unknown',
              extensionId: msg.extensionId ?? null,
            });
          }
          return;
        }

        // Silently ignore stale hello_ack (e.g., from heartbeat re-hello)
        if (msg.type === 'hello_ack') return;

        await handleCommand(msg);
      } catch (error) {
        console.error('[DUYA Bridge] Error handling message:', error);
        if (msg && msg.id) {
          sendResult(msg.id, { ok: false, error: error.message });
        }
      }
    };

    socket.onclose = (event) => {
      console.log('[DUYA Bridge] Disconnected from daemon', event.code, event.reason || '');
      clearConnectTimeout();
      if (ackTimeout) { clearTimeout(ackTimeout); ackTimeout = null; }
      if (ws === socket) ws = null;
      helloSent = false;
      isConnecting = false;
      finish({
        ok: false,
        connected: false,
        phase: 'closed',
        closeCode: event.code,
        closeReason: event.reason || '',
      });
      scheduleReconnect();
    };

    socket.onerror = (error) => {
      console.error('[DUYA Bridge] WebSocket error:', error);
      clearConnectTimeout();
      if (ackTimeout) { clearTimeout(ackTimeout); ackTimeout = null; }
      isConnecting = false;
    };
  });

  return connectPromise;
}

function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.log('[DUYA Bridge] Max reconnect attempts reached');
    return;
  }

  reconnectAttempts++;
  console.log(`[DUYA Bridge] Reconnecting in ${RECONNECT_INTERVAL}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { void connect(); }, RECONNECT_INTERVAL);
}

function sendSocketMessage(socket, msg) {
  if (socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(msg));
      return true;
    } catch (error) {
      console.error('[DUYA Bridge] Failed to send WS message:', error, msg?.type ?? 'unknown');
    }
  }
  return false;
}

function sendHello(socket) {
  const manifest = chrome.runtime.getManifest();
  const sent = sendSocketMessage(socket, {
    type: 'hello',
    name: manifest.name,
    version: manifest.version,
    extensionId: chrome.runtime.id,
    compatRange: '^1.0.0',
  });

  if (sent) {
    helloSent = true;
    console.log('[DUYA Bridge] Hello sent', { id: chrome.runtime.id, name: manifest.name, version: manifest.version });
    return { ok: true, connected: true, phase: 'hello_sent', helloSent: true };
  }

  helloSent = false;
  console.warn('[DUYA Bridge] Hello not sent because socket is not open', socket.readyState);
  return { ok: false, connected: false, phase: 'hello_not_sent', helloSent: false, readyState: socket.readyState };
}

function sendMessage(msg) {
  if (ws) {
    return sendSocketMessage(ws, msg);
  }
  return false;
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
        await handleTabs(id, msg);
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

      case 'cookies':
        await handleCookies(id, msg);
        break;

      case 'set-file-input':
        await handleSetFileInput(id, msg);
        break;

      case 'network-capture-start':
        await handleNetworkCaptureStart(id, msg);
        break;

      case 'network-capture-read':
        await handleNetworkCaptureRead(id, msg);
        break;

      case 'frames':
        await handleFrames(id, msg);
        break;

      case 'evaluate-in-frame':
        await handleEvaluateInFrame(id, msg);
        break;

      default:
        sendResult(id, { ok: false, error: `Unknown action: ${action}` });
    }
  } catch (error) {
    sendResult(id, { ok: false, error: unwrapDebuggerMessage(error) });
  }
}

// ─── CDP Command ─────────────────────────────────────────────────────

/**
 * Extract a human-readable message from a CDP Runtime.evaluate response
 * exceptionDetails payload. CDP's exceptionDetails.text is always the
 * literal string "Uncaught" for JS exceptions — the real reason lives in
 * exceptionDetails.exception.description (or .value as a fallback).
 */
function describeException(exceptionDetails) {
  if (!exceptionDetails) return 'Uncaught';
  const ex = exceptionDetails.exception || {};
  return (
    ex.description ||
    ex.value ||
    (ex.className && ex.description) ||
    exceptionDetails.text ||
    'Uncaught'
  );
}

/**
 * chrome.debugger sendCommand surfaces Runtime.evaluate uncaught exceptions
 * by throwing an error whose message is literally "Uncaught". Re-issue the
 * call wrapped in a try so we can recover the exceptionDetails payload —
 * chrome.debugger returns the full result (including exceptionDetails) on a
 * second call instead of throwing, so we can read it.
 */
async function safeEvaluate(debuggee, expression) {
  try {
    const result = await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result && result.exceptionDetails) {
      const err = new Error(describeException(result.exceptionDetails));
      err.exceptionDetails = result.exceptionDetails;
      throw err;
    }
    return result;
  } catch (err) {
    // If we already produced a detailed error, propagate it.
    if (err && err.exceptionDetails) throw err;
    throw new Error(unwrapDebuggerMessage(err));
  }
}

/**
 * Unwrap a chrome.debugger sendCommand thrown error. For most commands the
 * thrown message is descriptive enough (e.g. "No node with given id found"),
 * but for Runtime.evaluate it's just "Uncaught" — fall back to a generic
 * label rather than passing the literal "Uncaught" to the agent.
 */
function unwrapDebuggerMessage(err) {
  const msg = err && err.message ? String(err.message) : 'Unknown error';
  if (!msg || msg === 'Uncaught') return 'Runtime evaluation failed (Uncaught)';
  return msg;
}

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
        sendResult(id, { ok: false, error: unwrapDebuggerMessage(retryError) });
        return;
      }
    }
    sendResult(id, { ok: false, error: unwrapDebuggerMessage(error) });
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

async function handleTabs(id, msg) {
  const op = msg.op || 'list';

  if (op === 'list') {
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
    return;
  }

  if (op === 'new') {
    const sessionId = msg.sessionId;
    if (!sessionId) {
      sendResult(id, { ok: false, error: 'Missing sessionId for tabs new' });
      return;
    }
    const tabId = await getOrCreateSessionTab(sessionId);
    if (msg.url) {
      try {
        await chrome.tabs.update(tabId, { url: msg.url });
        await waitForTabLoad(tabId, 15000);
        try { await attachTab(tabId); } catch {}
      } catch (error) {
        sendResult(id, { ok: false, error: unwrapDebuggerMessage(error) });
        return;
      }
    }
    const tab = await chrome.tabs.get(tabId);
    sendResult(id, {
      ok: true,
      data: { tabId, url: tab.url, title: tab.title },
    });
    return;
  }

  if (op === 'select') {
    const sessionId = msg.sessionId;
    if (!sessionId) {
      sendResult(id, { ok: false, error: 'Missing sessionId for tabs select' });
      return;
    }
    const targetTabId = typeof msg.tabId === 'number'
      ? msg.tabId
      : parseInt(msg.tabId, 10);
    if (!targetTabId || Number.isNaN(targetTabId)) {
      sendResult(id, { ok: false, error: 'Missing or invalid tabId for tabs select' });
      return;
    }
    const session = sessionTabs.get(sessionId);
    if (!session) {
      sendResult(id, { ok: false, error: `No session "${sessionId}"` });
      return;
    }
    // Re-bind the session to the requested tab. The agent owns the new tabId
    // for this session, so subsequent commands will validate against it.
    session.tabId = targetTabId;
    try { await attachTab(targetTabId); } catch {}
    try {
      const tab = await chrome.tabs.get(targetTabId);
      sendResult(id, { ok: true, data: { tabId: targetTabId, url: tab.url, title: tab.title } });
    } catch (error) {
      sendResult(id, { ok: false, error: unwrapDebuggerMessage(error) });
    }
    return;
  }

  if (op === 'close') {
    const sessionId = msg.sessionId;
    if (!sessionId) {
      sendResult(id, { ok: false, error: 'Missing sessionId for tabs close' });
      return;
    }
    await closeSessionTab(sessionId);
    sendResult(id, { ok: true });
    return;
  }

  sendResult(id, { ok: false, error: `Unknown tabs op: ${op}` });
}

/**
 * Wait for a tab to reach 'complete' status, with a timeout fallback.
 */
function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      if (timer) clearTimeout(timer);
      resolve();
    };
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
  });
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
      // cssContentSize gives post-CSS-layout dimensions, which is what users
      // expect for a "full page" capture. Fall back to contentSize if missing.
      const size = metrics.cssContentSize || metrics.contentSize;
      if (!size || !size.width || !size.height) {
        sendResult(id, { ok: false, error: 'Could not determine full page size' });
        return;
      }
      await withTimeout(chrome.debugger.sendCommand(debuggee, 'Emulation.setDeviceMetricsOverride', {
        width: Math.ceil(size.width),
        height: Math.ceil(size.height),
        deviceScaleFactor: 1,
        mobile: false,
      }));
      // Give the renderer a moment to apply the new viewport before capture.
      // Without this, captureScreenshot can race the layout and return a
      // black or partial image on heavy pages (Twitter, Reddit, etc).
      await new Promise((r) => setTimeout(r, 250));

      let result;
      try {
        result = await withTimeout(chrome.debugger.sendCommand(debuggee, 'Page.captureScreenshot', { format: 'png' }));
      } finally {
        // Always reset the viewport, even if capture throws, so subsequent
        // commands run with the user's real viewport.
        await chrome.debugger.sendCommand(debuggee, 'Emulation.clearDeviceMetricsOverride', {}).catch(() => {});
      }
      sendResult(id, { ok: true, data: result });
    } else {
      const result = await withTimeout(chrome.debugger.sendCommand(debuggee, 'Page.captureScreenshot', { format: 'png' }));
      sendResult(id, { ok: true, data: result });
    }
  } catch (error) {
    sendResult(id, { ok: false, error: unwrapDebuggerMessage(error) });
  }
}

// ─── Evaluate ────────────────────────────────────────────────────────

async function handleEvaluate(id, msg) {
  const { tabId, script } = msg;
  const debuggee = await getOrAttachTab(tabId);

  try {
    const result = await safeEvaluate(debuggee, script);
    sendResult(id, { ok: true, data: result?.result?.value });
  } catch (error) {
    sendResult(id, { ok: false, error: unwrapDebuggerMessage(error) });
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
      // Ref-based clicking: snapshot wrote data-duya-ref="N", resolve it,
      // scroll into view, then click. Return a boolean so the caller can
      // distinguish "clicked" from "ref not found".
      const ref = selector.slice(1);
      const result = await safeEvaluate(debuggee, `(()=>{
        const el = document.querySelector('[data-duya-ref="${ref}"]');
        if (!el) return { ok: false, reason: 'ref_not_found', ref: '${ref}' };
        try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch {}
        el.click();
        return { ok: true };
      })()`);
      const value = result?.result?.value;
      if (value && value.ok === false) {
        sendResult(id, { ok: false, error: `Ref @${ref} not found in current page snapshot` });
        return;
      }
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
    sendResult(id, { ok: false, error: unwrapDebuggerMessage(error) });
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
      const result = await safeEvaluate(debuggee, `(()=>{
        const el = document.querySelector('[data-duya-ref="${ref}"]');
        if (!el) return { ok: false, reason: 'ref_not_found', ref: '${ref}' };
        try { el.focus(); } catch {}
        return { ok: true };
      })()`);
      const value = result?.result?.value;
      if (value && value.ok === false) {
        sendResult(id, { ok: false, error: `Ref @${ref} not found in current page snapshot` });
        return;
      }
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
    sendResult(id, { ok: false, error: unwrapDebuggerMessage(error) });
  }
}

// ─── Scroll ──────────────────────────────────────────────────────────

async function handleScroll(id, msg) {
  const { tabId, direction = 'down', amount = 300 } = msg;

  const scrollMap = {
    up: [0, -amount],
    down: [0, amount],
    left: [-amount, 0],
    right: [amount, 0],
  };

  const [deltaX, deltaY] = scrollMap[direction] || [0, amount];

  try {
    const debuggee = await getOrAttachTab(tabId);
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: 0, y: 0, deltaX, deltaY,
    });
    sendResult(id, { ok: true });
  } catch (error) {
    if (error.message?.includes('not attached') || error.message?.includes('Detached')) {
      try {
        attachedTabs.delete(String(tabId));
        const newDebuggee = await attachTab(tabId);
        await chrome.debugger.sendCommand(newDebuggee, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: 0, y: 0, deltaX, deltaY,
        });
        sendResult(id, { ok: true });
        return;
      } catch (retryError) {
        sendResult(id, { ok: false, error: retryError.message });
        return;
      }
    }
    sendResult(id, { ok: false, error: unwrapDebuggerMessage(error) });
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
    sendResult(id, { ok: false, error: unwrapDebuggerMessage(error) });
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
    sendResult(id, { ok: false, error: unwrapDebuggerMessage(error) });
  }
}

// ─── Cookies ──────────────────────────────────────────────────────────

async function handleCookies(id, msg) {
  const { tabId, domain, url } = msg;
  if (!tabId) {
    sendResult(id, { ok: false, error: 'Missing tabId for cookies' });
    return;
  }
  const debuggee = await getOrAttachTab(tabId);

  const filters = [];
  if (domain) filters.push('domain');
  if (url) filters.push('url');
  const params = {};
  if (domain) params.domains = [domain];
  if (url) params.urls = [url];

  try {
    const result = await chrome.debugger.sendCommand(debuggee, 'Network.getCookies', params);
    const cookies = (result?.cookies || []).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    }));
    sendResult(id, { ok: true, data: cookies });
  } catch (error) {
    sendResult(id, { ok: false, error: unwrapDebuggerMessage(error) });
  }
}

// ─── File Upload ──────────────────────────────────────────────────────

async function handleSetFileInput(id, msg) {
  const { tabId, selector, files } = msg;
  if (!tabId) {
    sendResult(id, { ok: false, error: 'Missing tabId for set-file-input' });
    return;
  }
  if (!Array.isArray(files) || files.length === 0) {
    sendResult(id, { ok: false, error: 'Missing files array for set-file-input' });
    return;
  }

  const debuggee = await getOrAttachTab(tabId);

  try {
    // Resolve the target input. If selector is given, use DOM.querySelector;
    // otherwise assume the page has a single file input or use the first match.
    let backendNodeId = null;
    if (selector) {
      const doc = await chrome.debugger.sendCommand(debuggee, 'DOM.getDocument', {});
      const rootNodeId = doc.root.nodeId;
      const result = await chrome.debugger.sendCommand(debuggee, 'DOM.querySelector', {
        nodeId: rootNodeId,
        selector,
      });
      if (!result.nodeId) {
        sendResult(id, { ok: false, error: `File input not found: ${selector}` });
        return;
      }
      // Walk up to a BackendNode so the file input can be addressed across
      // navigations. DOM.describeNode gives us the backendNodeId.
      const desc = await chrome.debugger.sendCommand(debuggee, 'DOM.describeNode', { nodeId: result.nodeId });
      backendNodeId = desc.node.backendNodeId;
    } else {
      // Pick the first <input type=file> in the document
      const doc = await chrome.debugger.sendCommand(debuggee, 'DOM.getDocument', {});
      const rootNodeId = doc.root.nodeId;
      const result = await chrome.debugger.sendCommand(debuggee, 'DOM.querySelector', {
        nodeId: rootNodeId,
        selector: 'input[type=file]',
      });
      if (!result.nodeId) {
        sendResult(id, { ok: false, error: 'No file input found on page' });
        return;
      }
      const desc = await chrome.debugger.sendCommand(debuggee, 'DOM.describeNode', { nodeId: result.nodeId });
      backendNodeId = desc.node.backendNodeId;
    }

    await chrome.debugger.sendCommand(debuggee, 'DOM.setFileInputFiles', {
      files,
      backendNodeId,
    });
    sendResult(id, { ok: true, count: files.length });
  } catch (error) {
    sendResult(id, { ok: false, error: unwrapDebuggerMessage(error) });
  }
}

// ─── Network Capture ──────────────────────────────────────────────────

const networkCaptures = new Map(); // tabId → { entries, pattern }

async function handleNetworkCaptureStart(id, msg) {
  const { tabId, pattern = '' } = msg;
  if (!tabId) {
    sendResult(id, { ok: false, error: 'Missing tabId for network-capture-start' });
    return;
  }

  const debuggee = await getOrAttachTab(tabId);

  try {
    // Make sure Network domain is enabled (it should be from attachTab)
    await chrome.debugger.sendCommand(debuggee, 'Network.enable');

    const capture = { entries: [], pattern, regex: null };
    if (pattern) {
      try {
        capture.regex = new RegExp(pattern);
      } catch (error) {
        sendResult(id, { ok: false, error: `Invalid network capture pattern: ${error.message}` });
        return;
      }
    }
    networkCaptures.set(String(tabId), capture);

    // Listen for all network events through the global onEvent listener
    // (we dispatch in the handler below).
    sendResult(id, { ok: true });
  } catch (error) {
    sendResult(id, { ok: false, error: unwrapDebuggerMessage(error) });
  }
}

async function handleNetworkCaptureRead(id, msg) {
  const { tabId } = msg;
  if (!tabId) {
    sendResult(id, { ok: false, error: 'Missing tabId for network-capture-read' });
    return;
  }
  const capture = networkCaptures.get(String(tabId));
  if (!capture) {
    sendResult(id, { ok: true, data: [] });
    return;
  }
  // Return a defensive copy and clear
  const entries = capture.entries.slice();
  capture.entries = [];
  sendResult(id, { ok: true, data: entries });
}

// ─── Iframe Support ───────────────────────────────────────────────────

async function handleFrames(id, msg) {
  const { tabId } = msg;
  if (!tabId) {
    sendResult(id, { ok: false, error: 'Missing tabId for frames' });
    return;
  }
  const debuggee = await getOrAttachTab(tabId);

  try {
    const result = await chrome.debugger.sendCommand(debuggee, 'Page.getFrameTree', {});
    const frames = [];
    const walk = (frame, index) => {
      frames.push({
        index,
        frameId: frame.id,
        url: frame.url || '',
        name: frame.name || '',
      });
    };
    let i = 0;
    const visit = (frame) => {
      walk(frame, i++);
      if (frame.childFrames) {
        for (const child of frame.childFrames) visit(child);
      }
    };
    if (result?.frameTree) visit(result.frameTree);
    sendResult(id, { ok: true, data: frames });
  } catch (error) {
    sendResult(id, { ok: false, error: unwrapDebuggerMessage(error) });
  }
}

async function handleEvaluateInFrame(id, msg) {
  const { tabId, frameIndex, script } = msg;
  if (!tabId) {
    sendResult(id, { ok: false, error: 'Missing tabId for evaluate-in-frame' });
    return;
  }
  if (typeof frameIndex !== 'number' || frameIndex < 0) {
    sendResult(id, { ok: false, error: 'Missing or invalid frameIndex for evaluate-in-frame' });
    return;
  }
  const debuggee = await getOrAttachTab(tabId);

  try {
    const tree = await chrome.debugger.sendCommand(debuggee, 'Page.getFrameTree', {});
    const frames = [];
    const visit = (frame) => {
      frames.push(frame);
      if (frame.childFrames) for (const child of frame.childFrames) visit(child);
    };
    if (tree?.frameTree) visit(tree.frameTree);
    const target = frames[frameIndex];
    if (!target) {
      sendResult(id, { ok: false, error: `Frame not found at index ${frameIndex}` });
      return;
    }

    // Use Runtime.evaluate inside the chosen frame's execution context.
    const result = await safeEvaluate(debuggee, script);
    sendResult(id, { ok: true, data: result?.result?.value });
  } catch (error) {
    sendResult(id, { ok: false, error: unwrapDebuggerMessage(error) });
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
        // Capture network traffic for any tab that has a capture registered
        if (method === 'Network.responseReceived' || method === 'Network.requestWillBeSent') {
          const capture = networkCaptures.get(String(source.tabId));
          if (capture) {
            const url = params?.response?.url || params?.request?.url;
            if (url) {
              if (!capture.regex || capture.regex.test(url)) {
                capture.entries.push({
                  ts: Date.now(),
                  method: method === 'Network.requestWillBeSent' ? 'request' : 'response',
                  url,
                  status: params?.response?.status,
                  method_http: params?.request?.method,
                  type: params?.type || params?.initiator?.type,
                });
              }
            }
          }
        }

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
    return false;
  }
  if (msg?.type === 'connect') {
    const startedAt = Date.now();
    connect()
      .then((result) => {
        sendResponse({ ...result, elapsedMs: Date.now() - startedAt });
      })
      .catch((error) => {
        sendResponse({ ok: false, connected: false, phase: 'error', error: error?.message ?? String(error) });
      });
    return true;
  }
  return false;
});
