import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import { randomUUID } from 'crypto';
import { platform as getPlatform } from 'os';
import * as path from 'path';
import * as fs from 'fs';

import { registerDbHandlers, registerConductorHandlers, registerMailboxHandlers } from './ipc/index';
import { initDatabaseFromBoot, getDatabase } from './db/connection';
import { registerAgentHandlers } from './agents/agent-communicator';
import { registerProviderIpcHandlers } from './services/providers/provider-ipc-handlers';
import { registerNetHandlers } from './ipc/net-handlers';
import { startGatewayProcess, stopGatewayProcess, registerGatewayIpcHandlers, forwardToGateway, isGatewaySession, waitForGatewayReady } from './gateway/index';
import { initConfigManager, getConfigManager, toLLMProvider, resolveDatabasePath, updateDatabasePath } from './config/index';
import { initChannelManager, getChannelManager } from './messaging/index';
import { initPerformanceMonitor } from './services/performance-monitor';
import { initSessionManager, getSessionManager } from './agents/session-manager';
import { RecapService } from './services/recap/recap-service';
import { registerRecapHandlers } from './ipc/recap-handlers';
import { initAgentProcessPool, getAgentProcessPool, AgentProcessPool } from './agents/process-pool/agent-process-pool';
import { startBrowserDaemon, stopBrowserDaemon, getBrowserExtensionStatus, setAllowedExtensionIds } from './services/browser/daemon';
import { getAutomationScheduler, initAutomationScheduler } from './automation/Scheduler';
import { initLogger, getLogger, LogComponent } from './logging/index';
import { initUpdater, checkForUpdates, downloadUpdate, installUpdate, getUpdaterState, cleanupUpdater } from './services/updater';
import { scanSkillFile, type SkillFinding, type SkillScanResult } from '../packages/agent/src/security/skillScanner.js';
import { initDocumentParser, getDocumentParser } from './services/document-parser/index';

// IPC handlers (extracted from main.ts)
import { registerSystemHandlers } from './ipc/system-handlers';
import { registerSettingsHandlers } from './ipc/settings-handlers';
import { registerSkillsHandlers } from './ipc/skills-handlers';
import { registerFilesHandlers } from './ipc/files-handlers';
import { registerLoggerHandlers } from './ipc/logger-handlers';
import { registerUpdaterHandlers } from './ipc/updater-handlers';
import { registerAgentServerHandlers } from './ipc/agent-server-handlers';
import { registerWikiAgentHandlers } from './ipc/wiki-agent-handlers';
import { registerPluginHandlers } from './ipc/plugin-handlers';
import { registerCapabilityManagementHandlers } from './ipc/capability-management-handlers';
import { registerMCPInventoryHandlers } from './ipc/mcp-inventory-handlers';
import { registerLiteratureHandlers } from './ipc/literature-handlers';
import { registerImportHandlers } from './import/import-handlers';
import { getMarketplaceSyncManager } from './plugins/marketplace';
import { scanDirectoryForPlugins } from './plugins/marketplace/temp-dir-marketplace';
import { initWikiAgentRuntime } from './wiki-agent/WikiAgentRuntime';
import { ConductorExecutorProxy } from './conductor/executor-proxy';
import type { ExecutorRpcRequest } from './conductor/executor-types';
import { getJsonSetting } from './db/queries/settings';

// =============================================================================
// Core modules (refactored from inline code)
// =============================================================================

import { isDev, isPreviewMode, DEBUG_IPC, debugLog, setupDevMode, initGlobalErrorHandlers, acquireSingleInstanceLock, setupSecondInstanceHandler, logEnvironmentDiagnostic } from './core/bootstrap';
import { getMainWindow, getIsQuitting, setIsQuitting, getIconPath, getRendererUrl, createWindow } from './core/window-manager';
import { createSafeModeWindow, getSafeModeWindow } from './core/safe-mode';
import { createTray } from './core/tray-manager';
import { getIsShuttingDown, performGracefulShutdown } from './core/graceful-shutdown';
import { parseSkillFrontmatter, parseAllowedTools } from './utils/skill-parser';
import { wasLaunchedAsHidden, setAutoStart, getAutoStartFromSettings, setAutoStartToSettings } from './services/auto-start';

// =============================================================================
// App Lifecycle: lock -> boot -> db -> config -> daemon/UI
// =============================================================================

const logger = initLogger({ level: 'WARN', console: true });

// Dev mode isolated userData, error handlers, single instance lock
setupDevMode();
initGlobalErrorHandlers();

const gotTheLock = acquireSingleInstanceLock();

app.on('second-instance', () => {
  const mainWindow = getMainWindow();
  if (mainWindow) {
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

if (gotTheLock) {
  app.whenReady().then(async () => {
    app.name = 'DUYA';
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.duya.app');
    }

    logEnvironmentDiagnostic();

    // ============================================================
    // Step 0.5: Cross-platform CLI install (best-effort, non-blocking)
    // ============================================================
    // After the app's userData path is known (via resolveDatabasePath
    // above), attempt to install the `duya` shell wrapper. This runs
    // once per app launch; on subsequent launches, the install is
    // idempotent and quick. We do NOT block startup on failure.
    try {
      const { installCliBestEffort } = await import('./services/cliInstallAuto.js');
      void installCliBestEffort();
    } catch (err) {
      logger.warn(
        'CLI install hook failed to load; skipping auto-install',
        { error: err instanceof Error ? err.message : String(err) },
        'Main',
      );
    }

    // ============================================================
    // Step 1: Read boot.json - resolve database path
    // ============================================================
    const { dbPath } = resolveDatabasePath();

    // ============================================================
    // Step 2: Initialize Database - with Safe Mode
    // ============================================================
    const dbResult = initDatabaseFromBoot();

    if (!dbResult.success) {
      logger.error('Database initialization failed', undefined, { error: dbResult.error }, 'Main');
      registerDbHandlers();
      registerConductorHandlers();
      registerMailboxHandlers();
      registerAgentHandlers();
      registerNetHandlers();
      createSafeModeWindow(dbResult.error || 'Unknown error', dbResult.dbPath || dbPath, getIconPath);
      return;
    }

    registerDbHandlers();
    registerConductorHandlers();

    // ============================================================
    // Step 3: Initialize ConfigManager
    // ============================================================
    const configManager = initConfigManager();
    initWikiAgentRuntime();

    // Migrate provider data from database to ConfigManager (one-time migration)
    try {
      const db = getDatabase();
      if (db) {
        const tableInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='api_providers'").get();
        if (tableInfo) {
          const providers = db.prepare('SELECT * FROM api_providers').all() as Array<{
            id: string;
            name: string;
            provider_type: string;
            base_url: string;
            api_key: string;
            is_active: number;
            sort_order: number;
            extra_env: string;
            headers_json: string;
            options_json: string;
            notes: string;
          }>;
          if (providers.length > 0) {
            for (const p of providers) {
              configManager.upsertProvider({
                id: p.id,
                name: p.name,
                providerType: (p.provider_type || 'anthropic') as 'anthropic' | 'openai' | 'ollama',
                baseUrl: p.base_url || '',
                apiKey: p.api_key || '',
                isActive: p.is_active === 1,
                sortOrder: p.sort_order || 0,
                extraEnv: p.extra_env ? JSON.parse(p.extra_env) : undefined,
                headers: p.headers_json ? JSON.parse(p.headers_json) : undefined,
                options: p.options_json ? JSON.parse(p.options_json) : undefined,
                notes: p.notes || '',
              });
            }
          }
        }
      }
    } catch (error) {
      logger.error('Provider migration failed', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
    }

    // ============================================================
    // Step 4: Initialize subsystems
    // ============================================================
    const channelManager = initChannelManager([
      { name: 'config', maxReconnectAttempts: 3 },
      { name: 'toolExec', maxReconnectAttempts: 5 },
      { name: 'toolStream', maxReconnectAttempts: 5 },
      // NOTE: agentControl channel removed - Phase 7.1 of plan 53
      // Agent communication now uses HTTP+SSE via Agent Server
    ]);

    initPerformanceMonitor();
    initSessionManager();

    // Recap service for session context recovery
    const recapService = new RecapService(getDatabase, getConfigManager, getSessionManager);
    registerRecapHandlers(recapService);

    registerAgentHandlers();
    registerProviderIpcHandlers();
    registerNetHandlers();
    registerGatewayIpcHandlers();

    // ============================================================
    // Step 4.5: Start Agent Server (HTTP+SSE for Agent communication)
    // ============================================================
    try {
      const { spawnAgentServer, stopAgentServer } = await import('./agents/agent-server-lifecycle');
      await spawnAgentServer();
      logger.info('Agent Server started', undefined, 'Main');

      // Register shutdown handler for Agent Server
      const { getIsShuttingDown } = await import('./core/graceful-shutdown');
      const originalIsShuttingDown = getIsShuttingDown();
      // Agent Server will be stopped by graceful shutdown
    } catch (error) {
      logger.error('Failed to start Agent Server', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
    }

    try {
      initAgentProcessPool();
    } catch (error) {
      logger.error('Failed to initialize agent process pool', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
    }

    try {
      const database = getDatabase();
      if (database) {
        initAutomationScheduler(database);
      }
    } catch (error) {
      logger.error('Failed to initialize automation scheduler', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
    }

    try {
      const docParser = initDocumentParser();
      await docParser.start();
    } catch (error) {
      logger.error('Failed to start document parser', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
    }

    // Apply app auto-start setting (Windows login)
    const autoStartValue = getAutoStartFromSettings();
    if (autoStartValue) {
      setAutoStart(true);
    }

    // Auto-start Gateway if bridge_auto_start is enabled
    try {
      const db = getDatabase();
      if (db) {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'bridge_auto_start'").get() as { value: string } | undefined;
        if (row?.value === 'true') {
          const { startGateway } = await import('./gateway/message-bus');
          await startGateway();
        }
      }
    } catch (error) {
      logger.error('Failed to auto-start Gateway', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
    }

    // ============================================================
    // Step 5: Start Browser Daemon
    // ============================================================
    try {
      const allowedExtensionIds = getJsonSetting<string[]>('browserExtensionAllowedIds', []);
      const normalizedExtensionIds = Array.from(new Set(
        (Array.isArray(allowedExtensionIds) ? allowedExtensionIds : [])
          .filter((id) => typeof id === 'string')
          .map((id) => id.trim())
          .filter((id) => id.length > 0),
      ));
      setAllowedExtensionIds(normalizedExtensionIds);
      await startBrowserDaemon();
    } catch (error) {
      logger.error('Failed to start Browser Daemon', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
    }

    // ============================================================
    // Step 5.5: Register custom file protocol for widget image embedding
    // ============================================================
    protocol.handle('duya-file', async (request) => {
      try {
        const url = new URL(request.url);
        let filePath = decodeURIComponent(url.pathname);

        if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(filePath)) {
          filePath = filePath.slice(1);
        }
        filePath = filePath.replace(/\//g, path.sep);

        const data = await fs.promises.readFile(filePath);

        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes: Record<string, string> = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.svg': 'image/svg+xml',
          '.webp': 'image/webp',
          '.bmp': 'image/bmp',
        };
        const mimeType = mimeTypes[ext] || 'application/octet-stream';

        return new Response(data, {
          status: 200,
          headers: { 'Content-Type': mimeType, 'Cache-Control': 'public, max-age=3600' },
        });
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    });

    // ============================================================
    // Step 6: Launch UI
    // ============================================================
    const agentPool = getAgentProcessPool();

    // Executor RPC handler - delegates to ConductorExecutorProxy
    const conductorExecutorProxy = new ConductorExecutorProxy();

    const handleExecutorRpc = async (rpcMsg: Record<string, unknown>, sessionId: string) => {
      const request: ExecutorRpcRequest = {
        requestId: rpcMsg.requestId as string,
        action: rpcMsg.action as ExecutorRpcRequest['action'],
        payload: rpcMsg.payload as Record<string, unknown>,
        sessionId,
      };

      const response = conductorExecutorProxy.execute(request);
      agentPool.send(sessionId, {
        type: 'conductor:executor:rpc:response',
        ...response,
      });
    };

    const handleConductorMessage = async (data: unknown) => {
      const msg = data as { type: string; sessionId?: string; prompt?: string; snapshot?: unknown; model?: string };
      const interruptedSessions = new Set<string>();

      if (msg.type === 'conductor:agent:start' && msg.sessionId && msg.prompt) {
        const conductorSessionId = msg.sessionId;

        try {
          const { isNew } = await agentPool.acquire(conductorSessionId);

          const setupAndStart = async () => {
            const configManager = getConfigManager();

            // Parse model: "[providerName] modelId" -> { providerName, modelId }
            let selectedModel: string | undefined;
            let targetProvider = null;

            if (msg.model) {
              const match = msg.model.match(/^\[(.+?)\]\s+(.+)$/);
              if (match) {
                const providerName = match[1];
                const cleanModelId = match[2];
                selectedModel = cleanModelId;

                const allProviders = configManager?.getAllProviders();
                if (allProviders) {
                  targetProvider = Object.values(allProviders).find(
                    (p) => p.name === providerName
                  );
                }
              }
            }

            // Fall back to active provider if no model specified or provider not found
            if (!targetProvider) {
              targetProvider = configManager?.getActiveProvider();
            }

            if (!targetProvider) {
              logger.error('No active provider configured for conductor agent', undefined, { sessionId: conductorSessionId }, LogComponent.Main);
              channelManager.sendToChannel('conductor', {
                type: 'conductor:error',
                sessionId: conductorSessionId,
                message: 'No active provider configured',
              });
              return;
            }

            const providerModel = selectedModel ||
              targetProvider.options?.defaultModel ||
              targetProvider.options?.model ||
              '';

            const llmProvider = toLLMProvider(targetProvider.providerType);

            logger.info('Sending conductor:init to agent process', { sessionId: conductorSessionId, model: providerModel, provider: llmProvider }, LogComponent.Main);
            const conductorInitSent = agentPool.send(conductorSessionId, {
              type: 'conductor:init',
              sessionId: conductorSessionId,
              providerConfig: {
                apiKey: targetProvider.apiKey,
                baseURL: targetProvider.baseUrl || undefined,
                model: providerModel,
                provider: llmProvider,
                authStyle: 'api_key',
              },
              snapshot: msg.snapshot,
              workingDirectory: '',
              systemPrompt: '',
            });

            if (!conductorInitSent) {
              logger.error('Failed to send conductor:init to agent process', undefined, { sessionId: conductorSessionId }, LogComponent.Main);
              channelManager.sendToChannel('conductor', {
                type: 'conductor:error',
                sessionId: conductorSessionId,
                message: 'Failed to initialize conductor agent process',
              });
              return;
            }

            // Set up message forwarding: agent process -> renderer via conductor channel
            agentPool.onMessage(conductorSessionId, (agentMsg) => {
              const am = agentMsg as Record<string, unknown>;
              if (am.type === 'conductor:text' || am.type === 'conductor:thinking' ||
                  am.type === 'conductor:tool_use' || am.type === 'conductor:tool_result' ||
                  am.type === 'conductor:status' || am.type === 'conductor:error' ||
                  am.type === 'conductor:done' || am.type === 'conductor:permission' ||
                  am.type === 'conductor:ready' || am.type === 'conductor:perception_context') {
                channelManager.sendToChannel('conductor', am);
              } else if (am.type === 'conductor:executor:rpc') {
                // Route to main process IPC handler (not renderer)
                handleExecutorRpc(am, conductorSessionId);
              } else if (am.type === 'pong') {
                // Heartbeat, ignore
              } else if (am.type === 'process:disconnected') {
                channelManager.sendToChannel('conductor', {
                  type: 'conductor:disconnected',
                  sessionId: conductorSessionId,
                });
              }
            });
          };

          if (isNew) {
            await setupAndStart();

            // Wait for conductor:ready before sending start (only for new processes)
            agentPool.waitForReady(conductorSessionId, 30000).then(() => {
              agentPool.send(conductorSessionId, {
                type: 'conductor:agent:start',
                sessionId: conductorSessionId,
                prompt: msg.prompt,
                snapshot: msg.snapshot,
              });
            }).catch((err: Error) => {
              if (!interruptedSessions.has(conductorSessionId)) {
                channelManager.sendToChannel('conductor', {
                  type: 'conductor:error',
                  sessionId: conductorSessionId,
                  message: `Conductor agent ready timeout: ${err.message}`,
                });
              }
            });
          } else {
            // Existing process — agent already sent ready, start directly
            agentPool.send(conductorSessionId, {
              type: 'conductor:agent:start',
              sessionId: conductorSessionId,
              prompt: msg.prompt,
              snapshot: msg.snapshot,
            });
          }
        } catch (err) {
          logger.error('Failed to start conductor agent', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
          channelManager.sendToChannel('conductor', {
            type: 'conductor:error',
            sessionId: msg.sessionId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } else if (msg.type === 'conductor:interrupt' && msg.sessionId) {
        interruptedSessions.add(msg.sessionId);
        agentPool.send(msg.sessionId, { type: 'conductor:interrupt' });
        agentPool.release(msg.sessionId);
      }
    };

    await createWindow(handleConductorMessage);
    recapService.init(getMainWindow()!);
    createTray();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow(handleConductorMessage).then(() => {
          const mw = getMainWindow();
          if (mw) recapService.init(mw);
        });
      } else {
        const mw = getMainWindow();
        if (mw) mw.show();
      }
    });
  });
}

// Register IPC handlers
registerSystemHandlers();
registerSettingsHandlers();
registerSkillsHandlers();
registerFilesHandlers();
registerLoggerHandlers();
registerUpdaterHandlers();
registerAgentServerHandlers();
registerWikiAgentHandlers();
registerPluginHandlers();
registerCapabilityManagementHandlers();
registerMCPInventoryHandlers();
registerLiteratureHandlers();
registerImportHandlers();

// =============================================================================
// Step 4.6: Start CLI API server (Phase 0 — read-only control plane)
//
// Only runs inside the single-instance main process (gotTheLock === true).
// Placement is intentionally BEFORE marketplace preload / auto-sync so the
// CLI control plane is never blocked by network catalog fetches. The server
// depends only on the local PluginManager (lazy singleton + synchronous
// registry read), so no other init step is required for it to serve requests.
// =============================================================================
void (async () => {
  try {
    const { startCliApiServer } = await import('./cli/cli-api-server');
    const handle = await startCliApiServer();
    logger.info('CLI API server listening', { port: handle.port, pid: process.pid }, 'Main');
  } catch (error) {
    logger.error(
      'Failed to start CLI API server',
      error instanceof Error ? error : new Error(String(error)),
      undefined,
      'Main',
    );
  }
})();

// Marketplace: handle --add-dir CLI flag
const addDirIndex = process.argv.indexOf('--add-dir');
if (addDirIndex >= 0 && process.argv[addDirIndex + 1]) {
  const dirPath = process.argv[addDirIndex + 1];
  try {
    const catalog = scanDirectoryForPlugins(dirPath);
    const syncManager = getMarketplaceSyncManager();
    syncManager.addLocalDir(`temp-dir-${Date.now()}`, dirPath);
    logger.info('Loaded --add-dir marketplace', { dirPath, pluginCount: Object.keys(catalog.plugins).length }, 'Main');
  } catch (err) {
    logger.error('Failed to load --add-dir marketplace', err instanceof Error ? err : new Error(String(err)), undefined, 'Main');
  }
}

// Marketplace: start auto-sync and preload catalogs
void getMarketplaceSyncManager().preloadCatalogs().catch((err) => {
  logger.warn('Marketplace catalog preload failed', { error: err instanceof Error ? err.message : String(err) }, 'Main');
});
getMarketplaceSyncManager().startAutoSync();

// =============================================================================
// Graceful Shutdown
// =============================================================================

app.on('window-all-closed', async () => {
  const { getIsQuitting } = require('./core/window-manager');
  if (getIsQuitting()) {
    const SHUTDOWN_TIMEOUT_MS = 10000;
    const shutdownPromise = performGracefulShutdown();

    const forceQuitTimeout = setTimeout(() => {
      logger.warn('window-all-closed shutdown timeout exceeded, forcing quit', undefined, 'Main');
      app.exit(0);
    }, SHUTDOWN_TIMEOUT_MS);

    try {
      await shutdownPromise;
      clearTimeout(forceQuitTimeout);
    } catch (err) {
      logger.error('Graceful shutdown failed in window-all-closed', err instanceof Error ? err : new Error(String(err)), undefined, 'Main');
      clearTimeout(forceQuitTimeout);
      app.exit(1);
    }

    if (process.platform !== 'darwin') {
      app.quit();
    }
  }
});

app.on('before-quit', (event) => {
  if (!getIsShuttingDown()) {
    event.preventDefault();
    const SHUTDOWN_TIMEOUT_MS = 10000;
    const shutdownPromise = performGracefulShutdown();

    const forceQuitTimeout = setTimeout(() => {
      logger.warn('Global shutdown timeout exceeded, forcing quit', undefined, 'Main');
      app.exit(0);
    }, SHUTDOWN_TIMEOUT_MS);

    shutdownPromise.then(() => {
      clearTimeout(forceQuitTimeout);
      app.quit();
    }).catch((err) => {
      logger.error('Graceful shutdown failed', err instanceof Error ? err : new Error(String(err)), undefined, 'Main');
      clearTimeout(forceQuitTimeout);
      app.exit(1);
    });
  }
});
