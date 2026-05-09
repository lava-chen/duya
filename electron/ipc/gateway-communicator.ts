/**
 * gateway-communicator.ts - IPC communication with Platform Gateway subprocess
 *
 * Manages the Gateway child process lifecycle and handles IPC
 * communication between Main Process and Gateway subprocess.
 *
 * Architecture:
 * - Gateway runs as a forked child_process (same pattern as AgentProcess)
 * - Inbound: platform message → Gateway → Main → AgentProcessPool
 * - Outbound: Agent stream event → Main → Gateway → platform API
 * - Permission: Agent → Main → Gateway → inline buttons → callback → Main → Agent
 * - DB: Gateway → Main (db:request) → SQLite (db:response) → Gateway
 */

import { ChildProcess, fork } from 'child_process';
import path from 'path';
import * as fs from 'fs';
import { homedir } from 'os';
import { app, ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import { getAgentProcessPool } from '../agent-process-pool.js';
import { getDatabase } from '../db-handlers.js';
import { getConfigManager, toLLMProvider } from '../config-manager.js';
import { testBridgeChannel } from '../net-handlers.js';
import { getProxyStatus } from '../../packages/gateway/dist/proxy-fetch.js';
import { getLogger, LogComponent } from '../logger.js';

// Helper to read a setting from the database
function getSetting(key: string): string | null {
  const db = getDatabase();
  if (!db) return null;
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

let gatewayProcess: ChildProcess | null = null;
let isReady = false;
let initSent = false;
let initComplete = false;

// Pending request callbacks (for Gateway → Main request/response pattern)
const pendingRequests = new Map<string, {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}>();

const REQUEST_TIMEOUT_MS = 30000;

// Track which sessions were created by the Gateway (for outbound routing)
const gatewaySessions = new Map<string, { platform: string; platformChatId: string }>();

function generateRequestId(): string {
  return `gw-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

export function sendRequest(type: string, data: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!gatewayProcess) {
      reject(new Error('Gateway process not running'));
      return;
    }

    const id = generateRequestId();
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Gateway request ${type} timed out`));
    }, REQUEST_TIMEOUT_MS);

    pendingRequests.set(id, { resolve, reject, timeout });
    gatewayProcess.send({ type, id, ...data });
  });
}

// =============================================================================
// Message handlers: Gateway → Main
// =============================================================================

interface GatewayMessage {
  type: string;
  id?: string;
  sessionId?: string;
  platform?: string;
  platformChatId?: string;
  platformMsgId?: string;
  prompt?: string;
  permissionId?: string;
  decision?: string;
  error?: string;
  status?: unknown;
  success?: boolean;
  result?: unknown;
  options?: Record<string, unknown>;
}

function handleMessage(msg: GatewayMessage): void {
  const logger = getLogger();
  switch (msg.type) {
    case 'gateway:ready': {
      logger.info('Gateway subprocess is ready', undefined, LogComponent.GatewayCommunicator);
      isReady = true;
      // Send init config once Gateway is ready
      if (!initSent && gatewayProcess) {
        initSent = true;
        const initConfig = buildInitConfig();
        logger.info('Sending init config...', undefined, LogComponent.GatewayCommunicator);
        gatewayProcess.send({ type: 'init', config: initConfig });
      }
      break;
    }

    case 'gateway:init:complete': {
      if (msg.success) {
        logger.info('Gateway init completed successfully', undefined, LogComponent.GatewayCommunicator);
        initComplete = true;
      } else {
        logger.error('Gateway init failed', new Error(msg.error || 'Unknown error'), undefined, LogComponent.GatewayCommunicator);
        initComplete = true; // Mark as complete even on failure to unblock waiters
      }
      break;
    }

    case 'gateway:inbound': {
      // External platform message arrived → trigger Agent chat
      handleInboundMessage(msg);
      break;
    }

    case 'gateway:permission_resolve': {
      // User clicked permission button on external platform
      handlePermissionResolve(msg);
      break;
    }

    case 'db:request': {
      // Gateway needs database access (same pattern as AgentProcess)
      handleDbRequest(msg);
      break;
    }

    case 'gateway:create_session': {
      // Gateway requests creation of a new session for inbound platform message
      handleCreateSession(msg);
      break;
    }

    case 'gateway:reset_session': {
      // /new command: reset session for a platform+chat, creating a fresh session
      handleResetSession(msg);
      break;
    }

    case 'gateway:error': {
      console.error('[GatewayCommunicator] Gateway error:', msg.error);
      break;
    }

    case 'gateway:getStatus:response': {
      // Response to status query
      if (msg.id) {
        const pending = pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingRequests.delete(msg.id);
          pending.resolve(msg.status);
        }
      }
      break;
    }

    default: {
      // Handle other :response messages
      if (msg.id && msg.type.endsWith(':response')) {
        console.log(`[GatewayCommunicator] Received response: ${msg.type}, id: ${msg.id}`);
        const pending = pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve(msg);
          }
        } else {
          console.log(`[GatewayCommunicator] No pending request for id: ${msg.id}`);
        }
      }
    }
  }
}

/**
 * Handle inbound message from external platform
 * Route to AgentProcessPool to start or continue a chat session
 *
 * This mirrors the flow in main.ts for renderer-initiated chat:start:
 * 1. Acquire an agent process (or reuse existing)
 * 2. If new, send init with provider config and wait for ready
 * 3. Register message handler to forward agent output to Gateway
 * 4. Send chat:start
 */
async function handleInboundMessage(msg: GatewayMessage): Promise<void> {
  const sessionId = msg.sessionId!;
  const prompt = msg.prompt ?? '';

  // Track this session as gateway-created (for outbound routing)
  gatewaySessions.set(sessionId, {
    platform: msg.platform ?? 'unknown',
    platformChatId: msg.platformChatId ?? '',
  });

  try {
    const pool = getAgentProcessPool();

    const { isNew } = await pool.acquire(sessionId);

    if (isNew) {
      const configManager = getConfigManager();
      const activeProvider = configManager?.getActiveProvider();
      if (!activeProvider) {
        console.error('[GatewayCommunicator] No active provider configured, cannot handle inbound message');
        pool.release(sessionId);
        return;
      }

      const db = getDatabase();
      const sessionRow = db?.prepare(
        'SELECT working_directory, system_prompt FROM chat_sessions WHERE id = ?'
      ).get(sessionId) as { working_directory: string; system_prompt: string } | undefined;
      const workingDirectory = sessionRow?.working_directory ?? '';
      const systemPrompt = sessionRow?.system_prompt || '';

      // Get model from gatewayModel setting, fallback to provider default
      const gatewayModel = getSetting('gatewayModel');
      const providerModel = gatewayModel ||
        (activeProvider.options?.defaultModel as string) ||
        (activeProvider.options?.model as string) ||
        '';

      // Get sandbox enabled setting
      let sandboxEnabled = true;
      try {
        const sandboxRow = db?.prepare("SELECT value FROM settings WHERE key = 'sandboxEnabled'").get() as { value: string } | undefined;
        if (sandboxRow?.value !== undefined) {
          sandboxEnabled = sandboxRow.value === 'true';
        }
      } catch {
        // ignore parse errors
      }

      pool.send(sessionId, {
        type: 'init',
        sessionId,
        providerConfig: {
          apiKey: activeProvider.apiKey,
          baseURL: activeProvider.baseUrl,
          model: providerModel,
          provider: toLLMProvider(activeProvider.providerType),
          authStyle: 'api_key',
        },
        workingDirectory,
        systemPrompt,
        communicationPlatform: msg.platform,
        sandboxEnabled,
      });

      await pool.waitForReady(sessionId, 30000);
      console.log(`[GatewayCommunicator] Agent ready for gateway session: ${sessionId}`);
    }

    // Register handler to forward agent output to Gateway (only once per session)
    if (isNew) {
      pool.onMessage(sessionId, (agentMsg) => {
        const agentMsgType = agentMsg.type as string;

        // Forward to Gateway for Telegram delivery
        if (isGatewaySession(sessionId)) {
          forwardToGateway(sessionId, agentMsg as Record<string, unknown>);
        }

        // Clean up when stream completes or errors
        if (agentMsgType === 'chat:done' || agentMsgType === 'chat:error') {
          pool.markSessionIdle(sessionId);
        }
      });
    }

    // Send chat:start to the agent process
    pool.send(sessionId, {
      type: 'chat:start',
      id: randomUUID(),
      sessionId,
      prompt,
      options: msg.options,
    });

    console.log(`[GatewayCommunicator] Inbound message routed to agent: session=${sessionId}`);
  } catch (err) {
    console.error('[GatewayCommunicator] Failed to route inbound message:', err);
  }
}

/**
 * Handle permission decision from external platform
 * Forward to AgentProcessPool to resolve the pending permission
 */
async function handlePermissionResolve(msg: GatewayMessage): Promise<void> {
  const permissionId = msg.permissionId!;
  const decision = msg.decision!;

  try {
    const db = getDatabase();
    if (!db) return;

    // Look up the session for this permission
    const permRow = db.prepare(
      'SELECT session_id FROM permission_requests WHERE id = ?'
    ).get(permissionId) as { session_id: string } | undefined;

    if (!permRow) {
      console.error('[GatewayCommunicator] Permission not found:', permissionId);
      return;
    }

    const pool = getAgentProcessPool();
    pool.send(permRow.session_id, {
      type: 'permission:resolve',
      id: permissionId,
      decision,
    });

    console.log(`[GatewayCommunicator] Permission resolved: ${permissionId} -> ${decision}`);
  } catch (err) {
    console.error('[GatewayCommunicator] Failed to resolve permission:', err);
  }
}

/**
 * Resolve the default working directory for Gateway sessions.
 * Priority:
 * 1. DUYA_GATEWAY_WORKSPACE environment variable
 * 2. bridge_workspace setting from database
 * 3. ~/.duya/workspace
 */
function resolveGatewayWorkspace(db?: import('better-sqlite3').Database | null): string {
  // 1. Environment variable override
  const envWorkspace = process.env.DUYA_GATEWAY_WORKSPACE?.trim();
  if (envWorkspace) {
    const expanded = path.resolve(envWorkspace.replace(/^~/, homedir()));
    try {
      if (!fs.existsSync(expanded)) {
        fs.mkdirSync(expanded, { recursive: true });
      }
      return expanded;
    } catch {
      console.warn('[GatewayCommunicator] Failed to create env workspace dir, falling back:', expanded);
    }
  }

  // 2. Database setting
  if (db) {
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('bridge_workspace') as { value: string } | undefined;
      const configured = row?.value?.trim();
      if (configured) {
        const expanded = path.resolve(configured.replace(/^~/, homedir()));
        if (!fs.existsSync(expanded)) {
          fs.mkdirSync(expanded, { recursive: true });
        }
        return expanded;
      }
    } catch {
      // Ignore DB errors, fall through
    }
  }

  // 3. Default: ~/.duya/workspace
  const defaultWorkspace = path.join(homedir(), '.duya', 'workspace');
  try {
    if (!fs.existsSync(defaultWorkspace)) {
      fs.mkdirSync(defaultWorkspace, { recursive: true });
    }
  } catch {
    console.warn('[GatewayCommunicator] Failed to create default workspace dir:', defaultWorkspace);
  }
  return defaultWorkspace;
}

/**
 * Handle session creation request from Gateway
 * Creates a new chat session for inbound platform messages
 */
async function handleCreateSession(msg: GatewayMessage): Promise<void> {
  const id = (msg as { id?: string }).id ?? '';
  const platform = (msg as { platform?: string }).platform ?? 'unknown';
  const platformUserId = (msg as { platformUserId?: string }).platformUserId ?? '';
  const platformChatId = (msg as { platformChatId?: string }).platformChatId ?? '';

  try {
    const db = getDatabase();
    if (!db) {
      gatewayProcess?.send({
        type: 'gateway:create_session:response',
        id,
        error: 'Database not initialized',
      });
      return;
    }

    // Generate a new session ID
    const sessionId = `gw-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const now = Date.now();

    // Resolve working directory for this gateway session
    const workingDirectory = resolveGatewayWorkspace(db);

    // Create the session in database
    db.prepare(
      `INSERT INTO chat_sessions (id, title, created_at, updated_at, working_directory, system_prompt)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sessionId, `Chat via ${platform}`, now, now, workingDirectory, '');

    console.log(`[GatewayCommunicator] Created session ${sessionId} for ${platform} user ${platformUserId}, workspace: ${workingDirectory}`);

    gatewayProcess?.send({
      type: 'gateway:create_session:response',
      id,
      sessionId,
    });
  } catch (err) {
    console.error('[GatewayCommunicator] Failed to create session:', err);
    gatewayProcess?.send({
      type: 'gateway:create_session:response',
      id,
      error: (err as Error).message,
    });
  }
}

/**
 * Handle session reset request from Gateway (/new command)
 * Creates a new session for the same (platform, platformChatId) and
 * clears the old session's messages.
 */
async function handleResetSession(msg: GatewayMessage): Promise<void> {
  const id = (msg as { id?: string }).id ?? '';
  const platform = (msg as { platform?: string }).platform ?? 'unknown';
  const platformChatId = (msg as { platformChatId?: string }).platformChatId ?? '';
  const platformUserId = (msg as { platformUserId?: string }).platformUserId ?? '';
  const platformMsgId = (msg as { platformMsgId?: string }).platformMsgId ?? '';

  try {
    const db = getDatabase();
    if (!db) {
      gatewayProcess?.send({
        type: 'gateway:reset_session:response',
        id,
        error: 'Database not initialized',
      });
      return;
    }

    const result = dispatchGatewayDbAction(db, 'gateway_user:resetMapping', {
      platform,
      platformChatId,
      platformUserId,
    }) as { oldSessionId: string; newSessionId: string };

    console.log(`[GatewayCommunicator] Session reset: ${result.oldSessionId} -> ${result.newSessionId} for ${platform}:${platformChatId}`);

    gatewayProcess?.send({
      type: 'gateway:reset_session:response',
      id,
      sessionId: result.newSessionId,
      oldSessionId: result.oldSessionId,
      platformMsgId,
    });
  } catch (err) {
    console.error('[GatewayCommunicator] Failed to reset session:', err);
    gatewayProcess?.send({
      type: 'gateway:reset_session:response',
      id,
      error: (err as Error).message,
    });
  }
}

/**
 * Handle database request from Gateway
 * Same pattern as AgentProcess db:request handling
 */
async function handleDbRequest(msg: GatewayMessage): Promise<void> {
  const id = (msg as { id?: string }).id ?? '';
  const action = (msg as { action?: string }).action ?? '';
  const payload = (msg as { payload?: unknown }).payload ?? {};
  const db = getDatabase();

  if (!db) {
    gatewayProcess?.send({
      type: 'db:response',
      id,
      success: false,
      error: 'Database not initialized',
    });
    return;
  }

  try {
    const result = dispatchGatewayDbAction(db, action, payload);
    gatewayProcess?.send({
      type: 'db:response',
      id,
      success: true,
      result,
    });
  } catch (err) {
    gatewayProcess?.send({
      type: 'db:response',
      id,
      success: false,
      error: (err as Error).message,
    });
  }
}

/**
 * Dispatch Gateway-specific DB actions
 */
function dispatchGatewayDbAction(
  db: import('better-sqlite3').Database,
  action: string,
  payload: unknown,
): unknown {
  const p = payload as Record<string, unknown>;

  switch (action) {
    // ==================== Gateway User Mapping ====================
    case 'gateway_user:getMapping': {
      return db.prepare(
        'SELECT session_id FROM gateway_user_map WHERE platform = ? AND platform_chat_id = ?'
      ).get(p.platform, p.platformChatId) as { session_id: string } | undefined;
    }

    case 'gateway_user:createMapping': {
      const id = randomUUID();
      const now = Date.now();
      db.prepare(`
        INSERT INTO gateway_user_map (id, platform, platform_user_id, platform_chat_id, session_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, p.platform, p.platformUserId, p.platformChatId, p.sessionId, now, now);
      return { id, session_id: p.sessionId };
    }

    case 'gateway_user:getChatForSession': {
      return db.prepare(
        'SELECT platform, platform_chat_id FROM gateway_user_map WHERE session_id = ?'
      ).get(p.sessionId) as { platform: string; platform_chat_id: string } | undefined;
    }

    case 'gateway_user:resetMapping': {
      // /new command: create a new session for the same (platform, platformChatId)
      // and update the gateway_user_map to point to it, then clear old session messages
      const oldMapping = db.prepare(
        'SELECT id, session_id, platform_user_id FROM gateway_user_map WHERE platform = ? AND platform_chat_id = ?'
      ).get(p.platform, p.platformChatId) as { id: string; session_id: string; platform_user_id: string } | undefined;

      if (!oldMapping) {
        throw new Error('No existing mapping found');
      }

      const newSessionId = `gw-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      const now = Date.now();

      // Resolve working directory for the new session
      const workingDirectory = resolveGatewayWorkspace(db);

      // Create new session
      db.prepare(
        `INSERT INTO chat_sessions (id, title, created_at, updated_at, working_directory, system_prompt)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(newSessionId, `Chat via ${p.platform}`, now, now, workingDirectory, '');

      // Clear old session messages
      db.prepare('DELETE FROM messages WHERE session_id = ?').run(oldMapping.session_id);

      // Update mapping to new session
      db.prepare(
        'UPDATE gateway_user_map SET session_id = ?, updated_at = ? WHERE id = ?'
      ).run(newSessionId, now, oldMapping.id);

      return { oldSessionId: oldMapping.session_id, newSessionId };
    }

    case 'session:clearMessages': {
      db.prepare('DELETE FROM messages WHERE session_id = ?').run(p.sessionId);
      return { ok: true };
    }

    // ==================== Gateway Message Map ====================
    case 'gateway_message:create': {
      const now = Date.now();
      db.prepare(`
        INSERT INTO gateway_message_map (platform, platform_msg_id, duya_message_id, session_id, direction, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(p.platform, p.platformMsgId, p.duyaMessageId, p.sessionId, p.direction ?? 'inbound', now);
      return { ok: true };
    }

    case 'gateway_message:getByPlatformMsgId': {
      return db.prepare(
        'SELECT * FROM gateway_message_map WHERE platform = ? AND platform_msg_id = ?'
      ).get(p.platform, p.platformMsgId);
    }

    // ==================== Channel Bindings (reuse existing) ====================
    case 'channel:getBindings': {
      if (p.channelType) {
        return db.prepare('SELECT * FROM channel_bindings WHERE channel_type = ? AND active = 1')
          .all(p.channelType);
      }
      return db.prepare('SELECT * FROM channel_bindings WHERE active = 1').all();
    }

    case 'channel:getOffset': {
      return db.prepare(
        'SELECT offset_value FROM channel_offsets WHERE channel_type = ? AND offset_key = ?'
      ).get(p.channelType, p.offsetKey) as { offset_value: string } | undefined;
    }

    case 'channel:setOffset': {
      const now = Date.now();
      db.prepare(`
        INSERT INTO channel_offsets (channel_type, offset_key, offset_value, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(channel_type, offset_key) DO UPDATE SET
          offset_value = excluded.offset_value,
          updated_at = excluded.updated_at
      `).run(p.channelType, p.offsetKey, p.offsetValue, now);
      return { ok: true };
    }

    default:
      throw new Error(`Unknown Gateway DB action: ${action}`);
  }
}

// =============================================================================
// Outbound: Main → Gateway
// =============================================================================

/**
 * Forward an Agent stream event to the Gateway for delivery to external platform
 * Called by AgentProcessPool when routing messages for gateway-created sessions
 */
export function forwardToGateway(sessionId: string, event: Record<string, unknown>): void {
  if (!gatewayProcess) return;

  gatewayProcess.send({
    type: 'gateway:outbound',
    sessionId,
    event,
  });
}

/**
 * Forward a permission request to the Gateway
 */
export function forwardPermissionToGateway(
  sessionId: string,
  permission: { id: string; toolName: string; toolInput: Record<string, unknown> },
): void {
  if (!gatewayProcess) return;

  gatewayProcess.send({
    type: 'gateway:permission_request',
    sessionId,
    permission,
  });
}

/**
 * Check if a session was created by the Gateway
 */
export function isGatewaySession(sessionId: string): boolean {
  return gatewaySessions.has(sessionId);
}

// =============================================================================
// Lifecycle
// =============================================================================

function getGatewayProcessPath(): string {
  // In dev: use the TypeScript-compiled output directly
  // In prod: electron-builder copies packages/gateway/bundle/** to resources/gateway-bundle/
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'gateway-bundle', 'gateway-process-entry.js');
    if (fs.existsSync(bundled)) return bundled;

    // Fallback to legacy path for backward compatibility
    const legacy = path.join(app.getAppPath(), 'packages', 'gateway', 'dist', 'index.js');
    return legacy;
  }

  const devBundled = path.join(process.cwd(), 'packages', 'gateway', 'bundle', 'gateway-process-entry.js');
  if (fs.existsSync(devBundled)) return devBundled;

  return path.join(process.cwd(), 'packages', 'gateway', 'dist', 'index.js');
}

export function startGatewayProcess(): boolean {
  if (gatewayProcess) {
    console.log('[GatewayCommunicator] Gateway process already running');
    return true;
  }

  const gatewayDistPath = getGatewayProcessPath();
  console.log('[GatewayCommunicator] Gateway path:', gatewayDistPath);

  try {
    gatewayProcess = fork(gatewayDistPath, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    // Capture stdout/stderr from Gateway subprocess for debugging
    gatewayProcess.stdout?.on('data', (data: Buffer) => {
      console.log('[Gateway stdout]', data.toString().trim());
    });
    gatewayProcess.stderr?.on('data', (data: Buffer) => {
      console.error('[Gateway stderr]', data.toString().trim());
    });

    gatewayProcess.on('message', handleMessage);

    gatewayProcess.on('error', (err) => {
      console.error('[GatewayCommunicator] Gateway process error:', err);
    });

    gatewayProcess.on('exit', (code) => {
      console.log(`[GatewayCommunicator] Gateway process exited with code ${code}`);
      gatewayProcess = null;
      isReady = false;
      initSent = false;
      initComplete = false;
    });

    return true;
  } catch (err) {
    console.error('[GatewayCommunicator] Failed to start gateway process:', err);
    return false;
  }
}

/**
 * Wait for Gateway to be fully initialized (init completed)
 */
export function waitForGatewayReady(timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (initComplete && gatewayProcess) {
      resolve();
      return;
    }
    const startTime = Date.now();
    const checkInterval = setInterval(() => {
      if (initComplete && gatewayProcess) {
        clearInterval(checkInterval);
        resolve();
        return;
      }
      if (Date.now() - startTime > timeoutMs) {
        clearInterval(checkInterval);
        reject(new Error('Gateway init timeout'));
      }
    }, 200);
  });
}

export function stopGatewayProcess(timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    if (!gatewayProcess) {
      resolve();
      return;
    }

    console.log('[GatewayCommunicator] Stopping gateway process...');
    const proc = gatewayProcess;
    const pid = proc.pid;

    // Reject all pending requests immediately
    pendingRequests.forEach((pending) => {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Gateway process stopped'));
    });
    pendingRequests.clear();

    // Clear state immediately so new requests fail fast
    gatewayProcess = null;
    isReady = false;
    initSent = false;
    initComplete = false;

    // Listen for exit event
    const onExit = () => {
      console.log('[GatewayCommunicator] Gateway process exited cleanly');
      cleanup();
      resolve();
    };

    const cleanup = () => {
      proc.removeListener('exit', onExit);
      clearTimeout(forceKillTimeout);
    };

    // Force kill after timeout using OS-specific mechanism
    const forceKillTimeout = setTimeout(() => {
      console.warn('[GatewayCommunicator] Gateway process did not exit in time, force killing...');
      if (process.platform === 'win32' && pid) {
        const { exec } = require('child_process');
        exec(`taskkill /F /T /PID ${pid}`, { windowsHide: true }, () => {
          // Ignore errors — process may already be gone
        });
      } else {
        try {
          proc.kill('SIGKILL');
        } catch {}
      }
      cleanup();
      resolve();
    }, timeoutMs);

    proc.once('exit', onExit);

    // Send graceful stop request first
    try {
      proc.send({ type: 'gateway:stop' });
    } catch {}

    // Use taskkill on Windows for reliable process tree termination.
    // Use exec (not spawn detached) to avoid creating orphan taskkill processes.
    if (process.platform === 'win32' && pid) {
      const { exec } = require('child_process');
      exec(`taskkill /F /T /PID ${pid}`, { windowsHide: true }, (err: Error | null) => {
        if (err) {
          // Process may already be gone; that's fine
          console.log('[GatewayCommunicator] taskkill result:', err.message);
        }
      });
    } else {
      proc.kill('SIGTERM');
    }
  });
}

export function isGatewayRunning(): boolean {
  return gatewayProcess !== null && isReady;
}

/**
 * Build Gateway init config from settings DB
 */
interface PlatformConfig {
  platform: string;
  enabled: boolean;
  credentials: Record<string, string>;
  options?: Record<string, unknown>;
}

interface GatewayInitConfig {
  platforms: PlatformConfig[];
  autoStart: boolean;
  proxyUrl?: string;
}

function buildInitConfig(): GatewayInitConfig {
  const db = getDatabase();
  if (!db) {
    return { platforms: [], autoStart: false };
  }

  // Read bridge/gateway settings from settings table
  const getSetting = (key: string): string | null => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  };

  const autoStart = getSetting('bridge_auto_start') === 'true';

  const platforms: PlatformConfig[] = [];

  // Telegram
  const telegramEnabled = getSetting('bridge_telegram_enabled') === 'true';
  const telegramToken = getSetting('telegram_bot_token') ?? '';
  if (telegramEnabled && telegramToken) {
    platforms.push({
      platform: 'telegram',
      enabled: true,
      credentials: { token: telegramToken },
    });
  }

  // Feishu
  const feishuEnabled = getSetting('bridge_feishu_enabled') === 'true';
  const feishuAppId = getSetting('bridge_feishu_app_id') ?? '';
  const feishuAppSecret = getSetting('bridge_feishu_app_secret') ?? '';
  if (feishuEnabled && feishuAppId && feishuAppSecret) {
    platforms.push({
      platform: 'feishu',
      enabled: true,
      credentials: {
        app_id: feishuAppId,
        app_secret: feishuAppSecret,
      },
      options: {
        domain: getSetting('bridge_feishu_domain') ?? 'feishu',
        dm_policy: getSetting('bridge_feishu_dm_policy') ?? 'open',
        group_policy: getSetting('bridge_feishu_group_policy') ?? 'open',
        require_mention: getSetting('bridge_feishu_require_mention') === 'true',
        thread_session: getSetting('bridge_feishu_thread_session') === 'true',
      },
    });
  }

  // WeChat - Read from weixin_accounts table (source of truth for QR login)
  const weixinEnabled = getSetting('bridge_weixin_enabled') === 'true';
  if (weixinEnabled && db) {
    try {
      const weixinAccounts = db.prepare(
        'SELECT account_id, base_url, cdn_base_url, token FROM weixin_accounts WHERE enabled = 1'
      ).all() as Array<{ account_id: string; base_url: string; cdn_base_url: string; token: string }>;

      console.log('[GatewayConfig] Found WeChat accounts in database:', weixinAccounts.length);

      for (const account of weixinAccounts) {
        if (account.token && account.account_id) {
          platforms.push({
            platform: 'weixin',
            enabled: true,
            credentials: {
              bot_token: account.token,
              account_id: account.account_id,
              base_url: account.base_url || '',
              cdn_base_url: account.cdn_base_url || '',
            },
          });
          console.log('[GatewayConfig] Added WeChat platform config:', account.account_id);
        } else {
          console.warn('[GatewayConfig] Skipping WeChat account with missing token or account_id:', account.account_id);
        }
      }
    } catch (err) {
      console.error('[GatewayConfig] Failed to read weixin_accounts:', err);
    }
  } else if (weixinEnabled) {
    console.warn('[GatewayConfig] WeChat enabled but database not available');
  }

  // QQ
  const qqEnabled = getSetting('bridge_qq_enabled') === 'true';
  const qqAppId = getSetting('bridge_qq_app_id') ?? '';
  const qqAppSecret = getSetting('bridge_qq_app_secret') ?? '';
  if (qqEnabled && qqAppId && qqAppSecret) {
    platforms.push({
      platform: 'qq',
      enabled: true,
      credentials: {
        app_id: qqAppId,
        app_secret: qqAppSecret,
      },
      options: {
        sandbox: getSetting('bridge_qq_sandbox') === 'true',
      },
    });
  }

  // WhatsApp
  const whatsappEnabled = getSetting('bridge_whatsapp_enabled') === 'true';
  if (whatsappEnabled) {
    const freeResponseChats = getSetting('whatsapp_free_response_chats');
    const mentionPatterns = getSetting('whatsapp_mention_patterns');
    platforms.push({
      platform: 'whatsapp',
      enabled: true,
      credentials: {
        session_path: getSetting('whatsapp_session_path') ?? '',
      },
      options: {
        dm_policy: getSetting('whatsapp_dm_policy') ?? 'open',
        group_policy: getSetting('whatsapp_group_policy') ?? 'open',
        require_mention: getSetting('whatsapp_require_mention') !== 'false',
        free_response_chats: freeResponseChats ? freeResponseChats.split(',').map(s => s.trim()).filter(Boolean) : [],
        mention_patterns: mentionPatterns ? mentionPatterns.split(',').map(s => s.trim()).filter(Boolean) : [],
      },
    });
  }

  const proxyUrl = getSetting('bridge_proxy_url') || null;

  return { platforms, autoStart, proxyUrl: proxyUrl || undefined };
}

// =============================================================================
// IPC Handlers (exposed to Renderer)
// =============================================================================

export function registerGatewayIpcHandlers(): void {
  ipcMain.handle('gateway:start', async () => {
    if (!gatewayProcess) {
      startGatewayProcess();
    }
    try {
      // Wait for Gateway to be ready before sending start command
      await waitForGatewayReady(10000);
      await sendRequest('gateway:start');
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('gateway:stop', async () => {
    try {
      await sendRequest('gateway:stop');
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('gateway:getStatus', async () => {
    // If gateway process is not running, check if there are recent gateway sessions
    // (the process may be orphaned due to main process reload in dev mode)
    if (!gatewayProcess) {
      console.log('[GatewayCommunicator] getStatus: gateway process not running, checking for orphaned process...');

      // Check if there are recent gateway sessions (indicates process may still be running)
      try {
        const db = getDatabase();
        if (db) {
          const recentSession = db.prepare(
            "SELECT id, updated_at FROM chat_sessions WHERE id LIKE 'gw-%' AND is_deleted = 0 ORDER BY updated_at DESC LIMIT 1"
          ).get() as { id: string; updated_at: number } | undefined;

          if (recentSession && Date.now() - recentSession.updated_at < 5 * 60 * 1000) {
            console.log('[GatewayCommunicator] getStatus: found recent gateway session, attempting to reconnect to orphaned process...');
            // Try to start a new process - it will fail if port is occupied, but that's ok
            const started = startGatewayProcess();
            if (started) {
              try {
                await waitForGatewayReady(5000);
                // Successfully started new process, continue to get status
              } catch {
                console.log('[GatewayCommunicator] getStatus: timeout waiting for new process, but recent activity detected');
                // Return a speculative status with configured adapters - the orphaned process may still be working
                const config = buildInitConfig();
                return {
                  running: true,
                  adapters: config.platforms.map(p => ({
                    channelType: p.platform,
                    running: true,
                    health: { connected: true, consecutiveErrors: 0, totalMessages: 0 },
                  })),
                  autoStart: config.autoStart,
                  _orphaned: true,
                };
              }
            } else {
              // Failed to start - likely port occupied by orphaned process
              console.log('[GatewayCommunicator] getStatus: failed to start new process (port may be occupied), assuming orphaned process is running');
              // Return status with configured adapters from settings
              const config = buildInitConfig();
              return {
                running: true,
                adapters: config.platforms.map(p => ({
                  channelType: p.platform,
                  running: true,
                  health: { connected: true, consecutiveErrors: 0, totalMessages: 0 },
                })),
                autoStart: config.autoStart,
                _orphaned: true,
              };
            }
          } else {
            // No recent activity, try to start normally
            console.log('[GatewayCommunicator] getStatus: no recent activity, starting new process...');
            const started = startGatewayProcess();
            if (!started) {
              console.log('[GatewayCommunicator] getStatus: failed to start gateway process');
              return { running: false, adapters: [], autoStart: false };
            }
            try {
              await waitForGatewayReady(5000);
            } catch {
              console.log('[GatewayCommunicator] getStatus: timeout waiting for gateway ready');
              return { running: false, adapters: [], autoStart: false };
            }
          }
        }
      } catch (dbErr) {
        console.log('[GatewayCommunicator] getStatus: error checking recent sessions:', dbErr);
        // Try to start anyway
        const started = startGatewayProcess();
        if (!started) {
          return { running: false, adapters: [], autoStart: false };
        }
        try {
          await waitForGatewayReady(5000);
        } catch {
          return { running: false, adapters: [], autoStart: false };
        }
      }
    }

    try {
      const status = await sendRequest('gateway:getStatus') as { running?: boolean; adapters?: Array<{ platform?: string; running?: boolean; lastMessageAt?: number; error?: string; health?: { connected?: boolean; lastConnectedAt?: number; lastErrorAt?: number; lastError?: string; consecutiveErrors?: number; totalMessages?: number; botUsername?: string } }>; autoStart?: boolean } ?? { running: false, adapters: [], autoStart: false };
      // Map platform -> channelType for UI compatibility
      return {
        ...status,
        adapters: (status.adapters ?? []).map(a => ({
          channelType: a.platform,
          running: a.running,
          lastMessageAt: a.lastMessageAt,
          error: a.error,
          health: a.health ? {
            connected: a.health.connected,
            lastConnectedAt: a.health.lastConnectedAt,
            lastErrorAt: a.health.lastErrorAt,
            lastError: a.health.lastError,
            consecutiveErrors: a.health.consecutiveErrors,
            totalMessages: a.health.totalMessages,
            botUsername: a.health.botUsername,
          } : undefined,
        })),
      };
    } catch (err) {
      console.log('[GatewayCommunicator] getStatus request failed:', err);
      // If request failed but process exists, return speculative status with configured adapters
      if (gatewayProcess) {
        try {
          const config = buildInitConfig();
          return {
            running: true,
            adapters: config.platforms.map(p => ({
              channelType: p.platform,
              running: true,
              health: { connected: true, consecutiveErrors: 0, totalMessages: 0 },
            })),
            autoStart: config.autoStart,
          };
        } catch {
          // Fall through to default return
        }
      }
      return { running: false, adapters: [], autoStart: false };
    }
  });

  ipcMain.handle('gateway:testChannel', async (_event, channel: string) => {
    // Channel testing is done directly via testBridgeChannel
    try {
      const result = await testBridgeChannel(channel);
      return result;
    } catch (err) {
      return { success: false, message: String(err) };
    }
  });

  ipcMain.handle('gateway:reload', async () => {
    try {
      const config = buildInitConfig();
      await sendRequest('gateway:reload', { config });
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('gateway:getProxyStatus', async () => {
    try {
      const status = getProxyStatus();
      return {
        success: true,
        status,
      };
    } catch (err) {
      return {
        success: false,
        error: String(err),
        status: {
          configured: undefined,
          env: undefined,
          system: undefined,
          effective: undefined,
        },
      };
    }
  });

  ipcMain.handle('gateway:listSessions', async () => {
    try {
      const db = getDatabase();
      if (!db) return [];
      // Get all gateway sessions (id starts with 'gw-') with platform info
      const sessions = db.prepare(`
        SELECT s.id, s.title, s.created_at, s.updated_at,
               g.platform, g.platform_user_id, g.platform_chat_id
        FROM chat_sessions s
        LEFT JOIN gateway_user_map g ON s.id = g.session_id
        WHERE s.id LIKE 'gw-%' AND s.is_deleted = 0
        ORDER BY s.updated_at DESC
      `).all() as Array<{
        id: string;
        title: string;
        created_at: number;
        updated_at: number;
        platform: string | null;
        platform_user_id: string | null;
        platform_chat_id: string | null;
      }>;
      return sessions.map(s => ({
        id: s.id,
        title: s.title || 'Untitled',
        platform: s.platform || 'unknown',
        platformUserId: s.platform_user_id || '',
        platformChatId: s.platform_chat_id || '',
        createdAt: s.created_at,
        updatedAt: s.updated_at,
      }));
    } catch (err) {
      console.error('[GatewayCommunicator] Failed to list sessions:', err);
      return [];
    }
  });

  ipcMain.handle('gateway:getSession', async (_event, sessionId: string) => {
    try {
      const db = getDatabase();
      if (!db) return null;
      const session = db.prepare(`
        SELECT s.id, s.title, s.created_at, s.updated_at,
               g.platform, g.platform_user_id, g.platform_chat_id
        FROM chat_sessions s
        LEFT JOIN gateway_user_map g ON s.id = g.session_id
        WHERE s.id = ? AND s.is_deleted = 0
      `).get(sessionId) as {
        id: string;
        title: string;
        created_at: number;
        updated_at: number;
        platform: string | null;
        platform_user_id: string | null;
        platform_chat_id: string | null;
      } | undefined;
      if (!session) return null;
      return {
        id: session.id,
        title: session.title || 'Untitled',
        platform: session.platform || 'unknown',
        platformUserId: session.platform_user_id || '',
        platformChatId: session.platform_chat_id || '',
        createdAt: session.created_at,
        updatedAt: session.updated_at,
      };
    } catch (err) {
      console.error('[GatewayCommunicator] Failed to get session:', err);
      return null;
    }
  });

  console.log('[GatewayCommunicator] IPC handlers registered');
}
