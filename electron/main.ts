import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import { randomUUID } from 'crypto';
import { platform as getPlatform, tmpdir } from 'os';
import * as path from 'path';
import * as fs from 'fs';

import { registerDbHandlers, registerConductorHandlers, registerMailboxHandlers, registerMemoryListHandlers, registerMemoryWakeupHandlers } from './ipc/index';
import { initDatabaseFromBoot, getDatabase, getSqliteCtor } from './db/connection';
import { initCoreDatabase } from './db/core-connection';
import { registerAgentHandlers } from './agents/agent-communicator';
import { registerProviderIpcHandlers } from './services/providers/provider-ipc-handlers';
import { registerNetHandlers } from './ipc/net-handlers';
import { startGatewayProcess, stopGatewayProcess, registerGatewayIpcHandlers, forwardToGateway, isGatewaySession, waitForGatewayReady } from './gateway/index';
import { initConfigManager, getConfigManager, toLLMProvider, resolveDatabasePath, updateDatabasePath, migrateMultiProviderV1 } from './config/index';
import { initChannelManager, getChannelManager } from './messaging/index';
import { initPerformanceMonitor } from './services/performance-monitor';
import { initSessionManager, getSessionManager } from './agents/session-manager';
import { RecapService } from './services/recap/recap-service';
import { registerRecapHandlers } from './ipc/recap-handlers';
import { initAgentProcessPool, getAgentProcessPool, AgentProcessPool } from './agents/process-pool/agent-process-pool';
import { startBrowserDaemon, stopBrowserDaemon, getBrowserExtensionStatus, setAllowedExtensionIds } from './services/browser/daemon';
import { attachBrowserDownloadHandler } from './services/browser/cookie-writer';
import { getAutomationScheduler, initAutomationScheduler } from './automation/Scheduler';
import { initLogger, getLogger, LogComponent } from './logging/index';
import { initUpdater, checkForUpdates, downloadUpdate, installUpdate, getUpdaterState, cleanupUpdater } from './services/updater';
import { scanSkillFile, type SkillFinding, type SkillScanResult } from '../packages/agent/src/security/skillScanner.js';
import { initDocumentParser, getDocumentParser } from './services/document-parser/index';
import { resolveMemoryModel } from './services/providers/memory-model-resolution';

// IPC handlers (extracted from main.ts)
import { registerSystemHandlers } from './ipc/system-handlers';
import { registerSettingsHandlers } from './ipc/settings-handlers';
import { registerSkillsHandlers } from './ipc/skills-handlers';
import { registerFilesHandlers } from './ipc/files-handlers';
import { registerReferencesHandlers } from './ipc/references-handlers';
import { registerLoggerHandlers } from './ipc/logger-handlers';
import { syncBuiltinPlugins } from './plugins/cache/builtin-sync.js';
import { registerUpdaterHandlers } from './ipc/updater-handlers';
import { registerAgentServerHandlers } from './ipc/agent-server-handlers';
import { registerPluginHandlers } from './ipc/plugin-handlers';
import { registerAppConnectionHandlers } from './ipc/app-connection-handlers';
import { registerCapabilityManagementHandlers } from './ipc/capability-management-handlers';
import { registerLiteratureHandlers } from './ipc/literature-handlers';
import { registerTerminalHandlers } from './ipc/terminal-handlers';
import { registerBrowserWebviewHandlers } from './ipc/browser-webview-handlers';
import { registerBrowserCookieHandlers } from './ipc/browser-cookie-handlers';
import { registerImportHandlers } from './import/import-handlers';
import { registerProjectDatabaseHandlers } from './ipc/project-database-handlers';
import { registerGitHandlers } from './ipc/git-handlers';
import { getMarketplaceSyncManager } from './plugins/marketplace';
import { scanDirectoryForPlugins } from './plugins/marketplace/temp-dir-marketplace';
import { ConductorExecutorProxy } from './conductor/executor-proxy';
import { getJsonSetting } from './db/queries/settings';

// =============================================================================
// Core modules (refactored from inline code)
// =============================================================================

import { isDev, isPreviewMode, DEBUG_IPC, debugLog, setupDevMode, setupTestMode, initGlobalErrorHandlers, acquireSingleInstanceLock, setupSecondInstanceHandler, logEnvironmentDiagnostic } from './core/bootstrap';
import { getMainWindow, getIsQuitting, setIsQuitting, getIconPath, getRendererUrl, createWindow } from './core/window-manager';
import { createSafeModeWindow, getSafeModeWindow } from './core/safe-mode';
import { createTray } from './core/tray-manager';
import { setupApplicationMenu } from './core/menu-manager';
import { getIsShuttingDown, performGracefulShutdown } from './core/graceful-shutdown';
import { parseSkillFrontmatter, parseAllowedTools } from './utils/skill-parser';
import { wasLaunchedAsHidden, setAutoStart, getAutoStartFromSettings, setAutoStartToSettings } from './services/auto-start';
import { getUserMcpTomlPath, migrateLegacyMcpServers, startUserMcpTomlWatcher } from './services/mcp-toml-config';

// =============================================================================
// App Lifecycle: lock -> boot -> db -> config -> daemon/UI
// =============================================================================

const logger = initLogger({ level: 'WARN', console: true });

// Dev mode isolated userData, error handlers, single instance lock
setupDevMode();
setupTestMode();
initGlobalErrorHandlers();

const gotTheLock = acquireSingleInstanceLock();

// macOS file-association / Dock drag-and-drop handling.
// `open-file` fires when the user drops a file onto the Dock icon or
// double-clicks an associated file in Finder. Without a handler Electron
// silently ignores the file. `will-finish-launching` is the documented
// moment to register the listener (it fires before ready). We queue paths
// and forward them to the renderer once the main window is available.
const pendingOpenFiles: string[] = [];
app.on('will-finish-launching', () => {
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('system:open-file', filePath);
    } else {
      // Window not ready yet (e.g. app launched by dropping a file on the
      // Dock icon). Queue and flush after the window is created.
      pendingOpenFiles.push(filePath);
    }
  });
});

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

    // Set the application menu early so the macOS menu bar shows "DUYA"
    // (not "Electron") and standard shortcuts (Cmd+Q/W/M, Edit copy/paste)
    // work from the first frame. Must run after app.name is set so the
    // macOS app-menu label reads "DUYA".
    setupApplicationMenu();

    logEnvironmentDiagnostic();

    // Project databases are independent from DUYA's application database.
    // Register this handler before boot DB initialization so renderer code can
    // never observe the preload API without its matching main-process route,
    // including when the application falls back to Safe Mode.
    registerProjectDatabaseHandlers();

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

    // Initialize the core database (duya-core.db + rollout files) for the
    // six core aggregates. Shares the same better-sqlite3 native binding as
    // the legacy database. See plan 328 Phase 1.
    const sqliteCtor = getSqliteCtor();
    if (sqliteCtor) {
      initCoreDatabase(sqliteCtor);
    } else {
      logger.warn('Skipping core database init — better-sqlite3 not loaded', undefined, 'Main');
    }

    registerDbHandlers();
    registerConductorHandlers();

    // ============================================================
    // Step 3: Initialize ConfigManager
    // ============================================================
    const configManager = initConfigManager();
    // One-shot boot migrations. Each migration is idempotent (guarded by
    // a marker in `AppConfig.migrations`), so it's safe to call on every boot.
    migrateMultiProviderV1(configManager);

    // One-time migration of user-managed MCPs. Runtime collection reads only
    // mcp.toml afterwards; plugin and bundled declarations remain separate.
    try {
      const db = getDatabase();
      const legacySettings = db
        ?.prepare("SELECT value FROM settings WHERE key = 'mcpServers'")
        .get() as { value?: string } | undefined;
      let settingsKv: unknown[] = [];
      let legacyFile: unknown[] = [];
      try {
        const parsed = legacySettings?.value ? JSON.parse(legacySettings.value) : [];
        settingsKv = Array.isArray(parsed) ? parsed : [];
      } catch {
        settingsKv = [];
      }
      try {
        const legacyPath = path.join(path.dirname(getUserMcpTomlPath()), 'settings.json');
        const parsed = JSON.parse(fs.readFileSync(legacyPath, 'utf8')) as { mcpServers?: unknown };
        legacyFile = Array.isArray(parsed.mcpServers) ? parsed.mcpServers : [];
      } catch {
        legacyFile = [];
      }
      const agentSettings = configManager.getAgentSettings() as unknown as { mcpServers?: unknown[] };
      await migrateLegacyMcpServers([
        Array.isArray(agentSettings.mcpServers) ? agentSettings.mcpServers as never[] : [],
        settingsKv as never[],
        legacyFile as never[],
      ]);
      startUserMcpTomlWatcher();
    } catch (error) {
      logger.warn('MCP TOML migration or watcher startup failed', {
        error: error instanceof Error ? error.message : String(error),
      }, LogComponent.AgentProcess);
    }

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
    // Plan 202: register mailbox handlers in the success path
    // too. Previously they were only registered in the
    // database-init failure branch, so the renderer's
    // `mailbox:list` calls returned "No handler registered".
    registerMailboxHandlers();
    registerTerminalHandlers();

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

    // ============================================================
    // Memory worker (Plan 305, shadow mode)
    // ============================================================
    // Gated by DUYA_MEMORY_ENABLED (legacy DUYA_MEMORY_V2_ENABLED still
    // honored). When enabled, bootstraps the memory-state DB (next to
    // duya-main.db), constructs an LLM client from the active provider,
    // and starts the long-lived worker that runs Stage 1 extraction +
    // outbox sweeper + reconcile.
    //
    // Shadow mode: writes only to memory-state.db and ~/.duya/memory
    // projection files. Never touches packages/agent/src/memory/.
    //
    // Dev default-on: in development, the worker starts automatically
    // to accumulate shadow data for the 4-week validation window
    // required by Plan 305 before promoting to default-on in prod.
    // Explicit opt-out via DUYA_MEMORY_ENABLED=0 still honored.
    const memoryExplicitOff = process.env.DUYA_MEMORY_ENABLED === '0' || process.env.DUYA_MEMORY_ENABLED === 'false'
      || process.env.DUYA_MEMORY_V2_ENABLED === '0' || process.env.DUYA_MEMORY_V2_ENABLED === 'false';
    const memoryExplicitOn = process.env.DUYA_MEMORY_ENABLED === '1' || process.env.DUYA_MEMORY_ENABLED === 'true'
      || process.env.DUYA_MEMORY_V2_ENABLED === '1' || process.env.DUYA_MEMORY_V2_ENABLED === 'true';
    const memoryEnabled = memoryExplicitOn || (isDev && !memoryExplicitOff);
    if (memoryEnabled) {
      try {
        const { bootstrap } = await import('./memory-state');
        const { startMemoryWorker } = await import('./memory/memory-worker');
        const { createAIClientWithRetry } = await import('@duya/ai');
        const { getDatabasePath } = await import('./config/boot-config');
        const { toLLMProvider } = await import('./config/index');
        const { toRuntimeConfigFromLegacy } = await import('@duya/ai');

        const mainDb = getDatabase();
        if (!mainDb) {
          throw new Error('Main DB not available for memory worker');
        }
        const memoryDb = bootstrap({ bootJsonDatabaseDir: path.dirname(getDatabasePath()) });

        // Plan 328 Phase 5: catalogSync now reads from the core DB
        // (`duya-core.db` sessions + message_index tables). Pull the
        // singleton CoreStores so the worker's catalogSync uses the
        // same handle the rest of the main process uses.
        const { getCoreStoresOrNull } = await import('./db/core-connection');
        const coreStores = getCoreStoresOrNull();
        if (!coreStores) {
          throw new Error(
            'Core stores not initialized — memory worker requires core DB (plan 328)',
          );
        }

        // Construct LLM client from the memory worker provider. When
        // memoryProviderId is unset, getMemoryProvider() falls back to
        // the default provider. Falls back gracefully if no provider is
        // configured — the worker will still run reconcile + outbox,
        // just no extraction.
        let llmClient = null;
        let curationProviderConfig = null;
        try {
          const cm = getConfigManager();
          const provider = cm.getMemoryProvider();
          if (provider) {
            const llmProvider = toLLMProvider(provider.providerType, provider.baseUrl);
            const model = resolveMemoryModel(
              provider,
              cm.getMemoryModel(),
              llmProvider === 'anthropic' || llmProvider === 'openai' || llmProvider === 'ollama'
                ? llmProvider
                : 'ollama',
            );
            logger.info('Memory worker: model resolved', { model, providerId: provider.id, memoryModelId: cm.getMemoryModel() }, LogComponent.DB);
            // Build a ProviderRuntimeConfig from the legacy ApiProvider so
            // domestic providers (MiniMax, DeepSeek, Qwen, GLM, Kimi) get
            // the correct apiFormat + modelCompat flags. Without these,
            // the Stage 1 extractor may misparse reasoning content.
            const runtime = toRuntimeConfigFromLegacy(provider, model);
            llmClient = createAIClientWithRetry({
              apiKey: provider.apiKey,
              baseURL: provider.baseUrl,
              model,
              apiFormat: runtime.apiFormat,
              providerId: runtime.providerId,
              modelCapabilities: runtime.modelCompat,
            });
            // Credentials for the Phase 2 curator subprocess (orchestrator
            // spawns it via the shared agent process pool).
            curationProviderConfig = {
              apiKey: provider.apiKey,
              model,
              baseUrl: provider.baseUrl,
              provider: llmProvider,
            };
          }
        } catch (llmErr) {
          logger.warn('Memory worker: LLM client construction failed; extraction disabled', { error: llmErr instanceof Error ? llmErr.message : String(llmErr) }, LogComponent.DB);
        }

        if (llmClient) {
          // Phase 2 curation wiring (Plan 406): without these deps every
          // curation tick is silently skipped (skipped_no_curation_deps).
          // The live config root sits inside the memory root; staging and
          // snapshots are siblings so run workspaces stay out of the
          // published tree.
          const os = await import('os');
          const memoryRoot = path.join(os.homedir(), '.duya', 'memory');
          const curation = curationProviderConfig
            ? {
                configRoot: path.join(memoryRoot, 'memory-config'),
                stagingRoot: path.join(os.homedir(), '.duya', 'memory-staging'),
                snapshotRoot: path.join(os.homedir(), '.duya', 'memory-snapshots'),
                providerConfig: curationProviderConfig,
                systemLocation: memoryRoot,
                pool: getAgentProcessPool(),
              }
            : undefined;
          startMemoryWorker(
            {
              memoryDb,
              mainDb,
              coreDb: coreStores.coreDb,
              sessions: coreStores.sessions,
              // Main process has no `process.send` — read messages from the
              // core store MessageLog directly (mirror of the db-bridge
              // `message:getBySession` case).
              readMessageRows: async (sessionId: string) => {
                const { storedEventsToIpcMessages } = await import('./ipc/core-db-adapters');
                return storedEventsToIpcMessages(coreStores.messageLog.listBySession(sessionId));
              },
              llmClient,
              curation,
            },
            { instancesPerMinute: 60, concurrency: 2 },
          );
          logger.info('Memory worker started (shadow mode)', { curation: curation ? 'wired' : 'disabled' }, LogComponent.DB);
        } else {
          logger.warn('Memory worker: no LLM client; worker not started', undefined, LogComponent.DB);
        }
      } catch (error) {
        logger.warn('Failed to start memory worker', { error: error instanceof Error ? error.message : String(error) }, LogComponent.DB);
      }
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
      attachBrowserDownloadHandler();
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
          '.pdf': 'application/pdf',
          '.txt': 'text/plain',
          '.md': 'text/markdown',
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

    // ── Canvas capture: main → renderer → main round-trip ───────────
    // Pending capture requests keyed by requestId. The renderer responds
    // via the `conductor:capture:response` IPC handler.
    const pendingCaptures = new Map<
      string,
      {
        resolve: (data: unknown) => void;
        reject: (err: Error) => void;
        timer: NodeJS.Timeout;
      }
    >();

    ipcMain.handle('conductor:capture:response', (_event, data: Record<string, unknown>) => {
      const requestId = data.requestId as string;
      const pending = pendingCaptures.get(requestId);
      if (!pending) return; // Stale response, ignore

      pendingCaptures.delete(requestId);
      clearTimeout(pending.timer);

      if (data.error) {
        pending.reject(new Error(String(data.error)));
        return;
      }

      const result = data.result as {
        dataUrl?: string;
        pngBase64?: string;
        width?: number;
        height?: number;
        scope?: string;
        capturedAt?: string;
      } | undefined;

      // Save screenshot to a file and return the file path instead of the
      // base64 dataUrl. This keeps the value passed back to the agent
      // (and ultimately the LLM) as a short string, avoiding the large
      // token cost of inlining base64 image data.
      const dataUrl = result?.dataUrl;
      if (!dataUrl) {
        pending.resolve(result);
        return;
      }

      try {
        const base64Match = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl);
        if (!base64Match) {
          pending.resolve(result);
          return;
        }
        const ext = base64Match[1] === 'jpeg' ? 'jpg' : base64Match[1];
        const buffer = Buffer.from(base64Match[2], 'base64');

        const capturesDir = path.join(tmpdir(), 'duya-captures');
        fs.mkdirSync(capturesDir, { recursive: true });
        const filename = `canvas_${Date.now()}.${ext}`;
        const filePath = path.join(capturesDir, filename);
        fs.writeFileSync(filePath, buffer);

        pending.resolve({
          filePath,
          width: result?.width,
          height: result?.height,
          scope: result?.scope,
          capturedAt: result?.capturedAt ?? new Date().toISOString(),
        });
      } catch (err) {
        getLogger().warn(
          '[capture] Failed to save screenshot to file, returning raw result',
          { error: err instanceof Error ? err.message : String(err) },
          LogComponent.Main,
        );
        pending.resolve(result);
      }
    });

    // Inject the capture function into the proxy. When the agent calls
    // `canvas.capture`, the proxy calls this function, which sends a
    // request to the renderer via the conductor channel and waits for
    // the renderer to respond via `conductor:capture:response` IPC.
    conductorExecutorProxy.setCaptureFn(
      (canvasId, scope, elementId?, region?) =>
        new Promise((resolve, reject) => {
          const requestId = randomUUID();
          // Match the worker-side timeout (CanvasCaptureTool uses 30s).
          // html2canvas can be slow on large canvases; 15s was too tight
          // and caused spurious timeouts before the renderer responded.
          const timeoutMs = 30000;
          const timer = setTimeout(() => {
            pendingCaptures.delete(requestId);
            logger.warn(
              'Canvas capture timed out waiting for renderer',
              { requestId, canvasId, scope, timeoutMs },
              LogComponent.Main,
            );
            reject(new Error(`Canvas capture timed out after ${timeoutMs}ms (renderer did not respond). Ensure a canvas view (ConductorView or SidebarConductorView) is mounted.`));
          }, timeoutMs);

          pendingCaptures.set(requestId, { resolve, reject, timer });

          logger.debug(
            'Sending canvas capture request to renderer',
            { requestId, canvasId, scope, elementId, hasRegion: !!region },
            LogComponent.Main,
          );
          channelManager.sendToChannel('conductor', {
            type: 'conductor:capture:request',
            requestId,
            canvasId,
            scope,
            elementId,
            region,
          });
        }),
    );

    // Inject the broadcast function so agent edits (canvas_create_element,
    // canvas_fill_content, etc.) push state:patch messages to the
    // renderer's conductor channel. Without this, the canvas only sees
    // agent edits on the next full snapshot reload — no live update.
    conductorExecutorProxy.setBroadcastPatch((patch) => {
      channelManager.sendToChannel('conductor', {
        type: 'conductor:state:patch',
        _v2: true,
        ...patch,
      });
    });
    conductorExecutorProxy.setCanvasManagementChangedFn((event) => {
      channelManager.sendToChannel('conductor', {
        type: 'conductor:canvas:changed',
        ...event,
      });
    });

    // Inject the proxy into the agent-server lifecycle so the main chat
    // worker can also reach it via the `conductor:executor:rpc` bridge.
    const { setConductorExecutorProxy } = await import('./agents/agent-server-lifecycle');
    setConductorExecutorProxy(conductorExecutorProxy);

    await createWindow();
    recapService.init(getMainWindow()!);
    createTray();

    // Flush any files queued before the window was ready (macOS open-file
    // events that arrived during cold launch from Dock/Finder).
    const mainWindow = getMainWindow();
    if (mainWindow && pendingOpenFiles.length > 0) {
      for (const f of pendingOpenFiles.splice(0)) {
        mainWindow.webContents.send('system:open-file', f);
      }
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow().then(() => {
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
registerReferencesHandlers();
registerLoggerHandlers();
registerUpdaterHandlers();
registerAgentServerHandlers();
// ============================================================
// Step 4.5a: Sync builtin plugins into ~/.duya/plugins/cache/builtin/
//
// Idempotent, synchronous, fast (small JSON+MD+YAML assets). Must run
// before registerPluginHandlers() so the first catalog read sees the
// synced builtin roots. Failures are non-fatal — the catalog tolerates
// an empty builtin set.
// ============================================================
try {
  syncBuiltinPlugins();
} catch (err) {
  logger.warn(
    'Builtin plugin sync failed; catalog may be missing builtin entries',
    { error: err instanceof Error ? err.message : String(err) },
    'Main',
  );
}
registerPluginHandlers();
registerAppConnectionHandlers();
registerCapabilityManagementHandlers();
registerLiteratureHandlers();
registerImportHandlers();
registerBrowserWebviewHandlers();
registerBrowserCookieHandlers();
registerGitHandlers();
registerMemoryListHandlers();
registerMemoryWakeupHandlers();

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
