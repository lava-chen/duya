import { app, BrowserWindow, ipcMain, protocol, session } from 'electron';
// Force synchronous evaluation of bootstrap module's top-level statements
// (`yd = !e1.app.isPackaged`, `xj = process.env.DUYA_TEST === '1'`, etc.) BEFORE
// any other module's lazy factory runs. Without this, esbuild's `ye(() => {...})`
// wrappers defer bootstrap.ts's `require('electron').app` until first export access;
// modules like messaging/index (S0e) invoke their own factories (`uee()` for
// document-parser) before reaching `bj()` for bootstrap, and document-parser's
// factory body dereferences bootstrap's `yd` — crashing with
// `Cannot read properties of undefined (reading 'isPackaged')`.
// Use CJS `require` so esbuild emits a synchronous `require(...)` call at the
// top of the bundle instead of a lazy ESM import. bootstrap's top level is
// idempotent (const assignments only).
// eslint-disable-next-line @typescript-eslint/no-var-requires
void require('./core/bootstrap');
import { randomUUID } from 'crypto';
import { platform as getPlatform, tmpdir, homedir } from 'os';
import * as path from 'path';
import * as fs from 'fs';

import { registerDbHandlers, registerConductorHandlers, registerSidebarSectionsHandlers, registerMailboxHandlers, registerMemoryListHandlers, registerMemorySystemLogHandlers, registerMemoryRagRebuildHandler, registerMemoryWakeupHandlers, registerComputerUseHandlers, registerBotChannelHandlers, registerGroupHandlers, registerBotHandlers } from './ipc/index';
import { initDatabaseFromBoot, getDatabase, getSqliteCtor } from './db/connection';
import { initCoreDatabase } from './db/core-connection';
import { registerAgentHandlers } from './agents/agent-communicator';
import { registerProviderIpcHandlers } from './services/providers/provider-ipc-handlers';
import { getProviderStore } from './services/providers/provider-store-electron';
import { registerNetHandlers } from './ipc/net-handlers';
import { registerDuyaLinkHandlers } from './ipc/duya-link-handlers';
import { startGatewayProcess, stopGatewayProcess, registerGatewayIpcHandlers, forwardToGateway, isGatewaySession, waitForGatewayReady } from './gateway/index';
import { resolveDatabasePath, updateDatabasePath } from './config/index';
import { getConfigStore } from './config/store-instance';
import { migrateConfig, migrateCronJobsToFile } from './config/migrate';
import { resolveConfigRoot, resolveConfigTomlPath } from './config/compass';
import { defaultCronFilePath } from './automation/cron-file';
import { initChannelManager, getChannelManager } from './messaging/index';
import { subscribeMcpConfigHotReload } from './services/mcp-config';
import { initPerformanceMonitor } from './services/performance-monitor';
import { sweepUnreferencedSnapshots } from './services/snapshot-gc';
import { resolveRolloutRoot } from './config/boot-config';
import { initLowPower, isLowPowerEnabled } from './services/low-power';
import { initSessionManager, getSessionManager } from './agents/session-manager';
import { RecapService } from './services/recap/recap-service';
import { registerRecapHandlers } from './ipc/recap-handlers';
import { registerNextStepHandlers } from './ipc/next-step-handlers';
import { initAgentProcessPool, getAgentProcessPool, AgentProcessPool } from './agents/process-pool/agent-process-pool';
import { startBrowserDaemon, stopBrowserDaemon, getBrowserExtensionStatus, setAllowedExtensionIds, setBrowserMaxTabs, DEFAULT_MAX_WEBVIEW_SESSIONS } from './services/browser/daemon';
import { attachBrowserDownloadHandler } from './services/browser/cookie-writer';
import { getAutomationScheduler, initAutomationScheduler } from './automation/Scheduler';
import { initRoutineListenerHub } from './automation/listener-hub';
import { initLogger, getLogger, LogComponent } from './logging/index';
import { initUpdater, checkForUpdates, downloadUpdate, installUpdate, getUpdaterState, cleanupUpdater } from './services/updater';
import { scanSkillFile, type SkillFinding, type SkillScanResult } from '../packages/agent/src/security/skillScanner.js';
import { initDocumentParser, getDocumentParser } from './services/document-parser/index';
import { resolveMemoryModel } from './services/providers/memory-model-resolution';
import { createRagIndexExecutor, type RagRefreshResult } from './memory/rag_refresh';
import { toLegacyApiProvider } from '../src/lib/providers/legacy';

// IPC handlers (extracted from main.ts)
import { registerSystemHandlers } from './ipc/system-handlers';
import { registerIdeHandlers } from './ipc/ide-handlers';
import { registerSettingsHandlers } from './ipc/settings-handlers';
import { registerSkillsHandlers } from './ipc/skills-handlers';
import { registerFilesHandlers } from './ipc/files-handlers';
import { registerReferencesHandlers } from './ipc/references-handlers';
import { registerLoggerHandlers } from './ipc/logger-handlers';
import { ensureOfficialMarketplace, syncAllMarketplaces } from './plugins/marketplace/manager';
import { registerUpdaterHandlers } from './ipc/updater-handlers';
import { registerAgentServerHandlers } from './ipc/agent-server-handlers';
import { registerPluginHandlers } from './ipc/plugin-handlers';
import { reconcilePluginAppDeclarations } from './services/app-connections/declarative/reconcile';
import { registerAppConnectionHandlers } from './ipc/app-connection-handlers';
import { registerCapabilityManagementHandlers } from './ipc/capability-management-handlers';
import { registerTerminalHandlers } from './ipc/terminal-handlers';
import { registerBrowserWebviewHandlers } from './ipc/browser-webview-handlers';
import { registerBrowserCookieHandlers } from './ipc/browser-cookie-handlers';
import { registerImportHandlers } from './import/import-handlers';
import { registerProjectDatabaseHandlers } from './ipc/project-database-handlers';
import { registerGitHandlers } from './ipc/git-handlers';
import { registerVoiceHandlers } from './ipc/voice-handlers';
import { registerHooksHandlers } from './ipc/hooks-handlers';
import { registerMcpReloadIpcHandler } from './ipc/mcp-handlers';
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


// =============================================================================
// App Lifecycle: lock -> boot -> db -> config -> daemon/UI
// =============================================================================

const logger = initLogger({ level: 'WARN', console: true });

// Dev mode isolated userData, error handlers, single instance lock
setupDevMode();
setupTestMode();
initGlobalErrorHandlers();

// Inline acquireSingleInstanceLock to avoid esbuild's lazy module-init issue:
// when bootstrap.ts is bundled, its module-level statements (including
// `require('electron').app`) are deferred into `bj = ye(() => { ... })`
// which only fires on first export access. Calling the bootstrap export
// here would dereference a not-yet-initialized `app` and crash with
// `Cannot read properties of undefined (reading 'isPackaged')`. Using
// main.ts's own `app` import skips that deferral because main.ts's top
// level is the bundle entry and executes synchronously.
const gotTheLock = process.env.DUYA_TEST === '1'
  ? (logger.info('Test mode: skipping single-instance lock', undefined, LogComponent.Main), true)
  : app.requestSingleInstanceLock()
  ? true
  : (app.quit(), false);

// Register the `duya-file://` custom scheme as privileged BEFORE the app is
// ready. The renderer can only load it as a subresource (e.g. an `<img>` src
// for markdown media or uploaded-image thumbnails) when it is registered as a
// standard scheme; otherwise Chromium treats it as an opaque, non-routable
// scheme and the image requests fail silently. `stream` is included so inline
// `<video>` sources also work.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'duya-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

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

/**
 * Run a non-critical startup task once the main window finished loading
 * (plan 426 Phase 6.3) so it never competes with first paint. Falls back
 * to the next macrotask when the renderer already settled —
 * `did-finish-load` may fire while `await createWindow()` resolves.
 */
function runAfterWindowReady(fn: () => void): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed() && win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', fn);
  } else {
    setTimeout(fn, 0);
  }
}

if (gotTheLock) {
  app.whenReady().then(async () => {
    app.name = 'DUYA';

    // Publish the bundled ripgrep path (resources/ripgrep/) as
    // DUYA_RIPGREP_PATH before any agent child process can spawn, so every
    // process.env-spreading spawn site inherits it (see electron/agents/ripgrep-path.ts).
    try {
      const { publishRipgrepEnv } = await import('./agents/ripgrep-path');
      publishRipgrepEnv();
    } catch {
      // Ripgrep stays optional — the agent's grep tool falls back to its
      // Node engine when neither the bundled binary nor PATH provides rg.
    }

    // Dev-mode renderer disk cache can serve stale module transforms
    // whose `?v=<optimize hash>` imports 404 after Vite re-optimizes
    // deps with a different hash (Vite's module ETag is derived from
    // the source file, not the transformed output). Clear it once at
    // startup so dev windows always refetch fresh module graphs.
    if (!app.isPackaged) {
      session.defaultSession.clearCache().catch(() => {});
    }
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.duya.app');
    }

    // Set the application menu early so the macOS menu bar shows "DUYA"
    // (not "Electron") and standard shortcuts (Cmd+Q/W/M, Edit copy/paste)
    // work from the first frame. Must run after app.name is set so the
    // macOS app-menu label reads "DUYA".
    setupApplicationMenu();

    logEnvironmentDiagnostic();

    // ============================================================
    // Step 0.75: Subagent transcript root unification (~/.duya)
    // ============================================================
    // Commit 28c8c8bb moved OutputFileWriter transcripts from the OS
    // app-data directory to ~/.duya/subagent-transcripts. Copy any legacy
    // files so the canonical root holds everything while historical
    // <output-file> notification paths keep resolving. Idempotent; never
    // blocks startup (a handful of small copies at most).
    try {
      const { migrateSubagentTranscripts } = await import('./services/subagent-transcript-migration');
      migrateSubagentTranscripts();
    } catch (err) {
      logger.warn(
        'Subagent transcript migration failed to load; skipping',
        { error: err instanceof Error ? err.message : String(err) },
        'Main',
      );
    }

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
      registerSidebarSectionsHandlers();
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
    registerSidebarSectionsHandlers();

    // Plan 488 P6 — start the per-bot inbound connectors (grok-form channel
    // model). Bindings and credentials are file-based (agents/<id>/…), so this
    // only needs userData resolved; wakes lazily open the core store.
    try {
      const { getBotConnectorManager } = await import('./channels/connector-runtime');
      getBotConnectorManager().start();
    } catch (err) {
      logger.warn('Bot connector runtime failed to start', err instanceof Error ? err : new Error(String(err)), 'Main');
    }

    // Plan 454 follow-up: register the DesktopBackend singleton so
    // electron/ipc/computer-use.ts can dispatch actions. The init
    // is best-effort — if nut.js / sharp fail to load (headless CI,
    // missing prebuilt binary), the mode still registers but every
    // call returns a structured error from the dispatcher.
    try {
      const { initializeComputerUseBackend } = await import(
        './services/computer-use-backend'
      );
      initializeComputerUseBackend();
    } catch (err) {
      logger.warn(
        'Computer Use backend bootstrap import failed',
        {
          error: err instanceof Error ? err.message : String(err),
        },
        'Main',
      );
    }

    // Plan 429 #3 cleanup strategy: sweep pre-image snapshot blobs whose
    // referencing turns no longer exist in any rollout. Delayed + detached so
    // startup latency is unaffected; a missed run simply waits for the next.
    setTimeout(() => {
      const rolloutsRoot = resolveRolloutRoot();
      void sweepUnreferencedSnapshots({
        snapshotRoot: path.join(rolloutsRoot, 'snapshots'),
        rolloutsRoot: path.join(rolloutsRoot, 'sessions'),
      }).catch((err) => {
        logger.warn(
          'Snapshot GC sweep failed',
          { error: err instanceof Error ? err.message : String(err) },
          'Main',
        );
      });
    }, 30_000).unref();

    // ============================================================
    // Step 3: ConfigStore (in-memory snapshot + TOML persistence)
    // ============================================================
    // Legacy single-active-provider migration (`migrateMultiProviderV1`) and
    // `initConfigManager` are gone: the isActive -> defaultProviderId promotion
    // is folded into `migrateConfig` (migrateSettingsJson), which runs below.
    // Provider reads go through `getProviderStore()`/`getConfigStore()`.

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

    // Plan 426 Phase 3: resolve performance.lowPower BEFORE any child
    // processes spawn — the agent server inherits DUYA_LOW_POWER from
    // process.env, and main services read isLowPowerEnabled() live.
    initLowPower();

    initPerformanceMonitor();
    initSessionManager();

    // Recap service for session context recovery
    const recapService = new RecapService(getDatabase, getSessionManager);
    registerRecapHandlers(recapService);

    // Next-step suggestions (end-of-turn follow-up option cards)
    registerNextStepHandlers();

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
    // Plan 454: register the computer-use IPC handler so the agent
    // process can dispatch `computer-use:execute` messages to the
    // DesktopBackend singleton. Without this, every computer_use
    // tool call times out at the IPC layer with "No handler
    // registered" after 30s — exactly the drift signature reported
    // when this registration was missing.
    registerComputerUseHandlers();

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

    // Hot reload: manual edits to config.toml `mcp_servers` are picked up
    // without restarting DUYA (ConfigStore watches the file; this forwards
    // the change to the worker reload path).
    subscribeMcpConfigHotReload();

    // One-time migration of legacy config sources into config.toml
    // (plan 334, Phase 3). Idempotent: skips once config.toml exists.
    try {
      const configPath = resolveConfigTomlPath();
      const db = getDatabase();
      if (db) {
        migrateConfig(db, {
          store: getConfigStore(),
          configPath,
          secretsPath: path.join(path.dirname(configPath), 'secrets.json'),
        });
        // Cron definitions converge into the single-source cronjob.toml.
        migrateCronJobsToFile(db, {
          configPath,
          cronFilePath: defaultCronFilePath(),
        });
      }
    } catch (error) {
      logger.error('Failed to migrate legacy config to config.toml', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
    }

    try {
      const scheduler = initAutomationScheduler();
      initRoutineListenerHub(scheduler.getCronStore());
    } catch (error) {
      logger.error('Failed to initialize automation scheduler', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
    }

    // ============================================================
    // Step 0.85: computer-use-demo daemon (Plan 453 Task D)
    // ============================================================
    // The daemon runs as a long-lived child process and writes
    // `~/.duya/context/<sessionId>.json` for the OSContextBridge. Only
    // initialised when `[wake] enabled = true`; if disabled, we skip
    // spawn entirely (the bridge stays quiet per its default state).
    try {
      const { setComputerUseDaemonOptions, getComputerUseDaemon } =
        await import('./services/computer-use-daemon');
      const configStore = getConfigStore();
      // Default `wake.enabled` is true when unset (privacy-by-default
      // means we ship with the bridge on; the daemon itself is opt-in
      // by file presence).
      const wakeEnabled = (configStore.getByPath('wake.enabled') ?? true) !== false;
      if (wakeEnabled) {
        const resolved = await resolveComputerUseDaemonEntry();
        if (resolved) {
          const { entry, runtime } = resolved;
          setComputerUseDaemonOptions({
            entry,
            runtime,
            cwd: path.dirname(entry),
            contextDir: path.join(homedir(), '.duya', 'context'),
          });
          await getComputerUseDaemon().start();
        } else {
          logger.info(
            'ComputerUseDaemon entry not found; skipping spawn. ' +
              'Build the daemon (cd E:\\Projects\\computer-use-demo && npm run build) or run it externally.',
            undefined,
            'Main',
          );
        }
      }
    } catch (error) {
      logger.error(
        'Failed to start computer-use-demo daemon',
        error instanceof Error ? error : new Error(String(error)),
        undefined,
        'Main',
      );
    }

    // ============================================================
    // Step 0.9: Wake Agent hotkey + Orb (Plan 453 Task E)
    // ============================================================
    // Registers the global hotkey + IPC handlers + wires the orb
    // window accessor so the orb IPC can send `main → orb` messages.
    // The actual orb BrowserWindow is created lazily on first wake.
    try {
      const { initializeWakeService, defaultOrbPosition } =
        await import('./services/wake');
      const { registerOrbHandlers, setOrbWindowAccessor } =
        await import('./ipc/orb');
      const configStore = getConfigStore();
      const wakeEnabled = (configStore.getByPath('wake.enabled') ?? true) !== false;
      if (wakeEnabled) {
        // Default trigger: Shift+= pressed twice within 600ms.
        // Mirrors the daemon's own Shift++= trigger so the user
        // only learns one combo. Ctrl+Shift+Space is the previous
        // default and remains available via config.toml [wake]
        // .shortcut override.
        const shortcut = (configStore.getByPath('wake.shortcut') as string | undefined) ??
          'Shift+=';
        const wake = initializeWakeService({
          defaultShortcut: shortcut,
          doubleTap: true,
          doubleTapWindowMs: 600,
          // Dev: vite serves the orb entry at /src/orb/ (multi-input
          // keeps the source-relative path). Vite runs on port 3000
          // in this project (see package.json electron:dev).
          orbDevUrl: !app.isPackaged
            ? (process.env.DUYA_ORB_DEV_URL ?? 'http://localhost:3000/src/orb/')
            : undefined,
          orbResourcesPath: app.isPackaged
            ? path.join(process.resourcesPath, 'orb')
            : undefined,
        });
        // Restore persisted position if available.
        const persisted = configStore.getByPath('wake.orb') as
          | { x?: number; y?: number; displayId?: number }
          | undefined;
        if (persisted && typeof persisted.x === 'number' && typeof persisted.y === 'number') {
          wake.setPosition({
            x: persisted.x,
            y: persisted.y,
            displayId: typeof persisted.displayId === 'number' ? persisted.displayId : 0,
          });
        } else {
          wake.setPosition(defaultOrbPosition());
        }
        // Phase F (Plan session-floater): restore the persisted session
        // envelope so a reload (or just reopening the orb) shows the
        // previous conversation. Best-effort; missing/corrupt entries
        // fall back to an empty session inside wake.loadSession().
        if (typeof wake.loadSession === 'function') {
          wake.loadSession();
        }
        // Wire orb IPC handlers + accessor for `main → orb` sends.
        registerOrbHandlers();
        setOrbWindowAccessor(() => wake.getOrbWindow());
        logger.info(
          'Wake service initialized',
          { shortcut },
          'Main',
        );
      }
    } catch (error) {
      logger.error(
        'Failed to initialize wake service',
        error instanceof Error ? error : new Error(String(error)),
        undefined,
        'Main',
      );
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
        const { startMemoryWorker, applyLowPowerOverrides } = await import('./memory/memory-worker');
        const { createAIClientWithRetry } = await import('@duya/ai');
        const { getDatabasePath } = await import('./config/boot-config');
        const { toLLMProvider } = await import('./config/provider-types');
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
          const providerStore = getProviderStore();
          const activeLlm = providerStore.getMemoryLlmProvider();
          const provider = activeLlm ? toLegacyApiProvider(activeLlm) : undefined;
          if (provider) {
            const memoryModel = providerStore.getMemoryModel();
            const llmProvider = toLLMProvider(provider.providerType, provider.baseUrl);
            const model = resolveMemoryModel(
              provider,
              memoryModel,
              llmProvider === 'anthropic' || llmProvider === 'openai' || llmProvider === 'ollama'
                ? llmProvider
                : 'ollama',
            );
            logger.info('Memory worker: model resolved', { model, providerId: provider.id, memoryModelId: memoryModel }, LogComponent.DB);
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
          // The curator works directly on the live memory root (simplified
          // flow, 2026-08-09); a git backup is taken before each run.
          const os = await import('os');
          const memoryRoot = path.join(os.homedir(), '.duya', 'memory');

          // RAG index refresh (plan 428): rebuild the retrievable memory
          // index after each successful curation run. Enabled via
          // `[memory.rag].enabled`; the embedding client resolves through
          // the provider framework (falling back to keyword-only when the
          // provider has no embeddings endpoint). Shared executor built in
          // `memory/rag_refresh.ts` (also used by CLI / Settings rebuild).
          let ragRefresh: ((memoryRoot: string) => Promise<RagRefreshResult | undefined>) | undefined;
          try {
            ragRefresh = createRagIndexExecutor()?.refresh;
          } catch (ragErr) {
            logger.warn(
              'RAG index refresh setup failed; disabled',
              { error: ragErr instanceof Error ? ragErr.message : String(ragErr) },
              LogComponent.DB,
            );
          }

          const curation = curationProviderConfig
            ? {
                configRoot: path.join(memoryRoot, 'memory-config'),
                providerConfig: curationProviderConfig,
                ragRefresh,
              }
            : undefined;

          // Ensure the curation config root exists with default files. Without
          // `memory-config/`, the memory_write tool and the Stage 1 extractor
          // have no policy to read.
          if (curation) {
            try {
              await ensureMemoryConfigDir(curation.configRoot);
            } catch (initErr) {
              logger.warn(
                'Memory worker: config root init failed; curation may be skipped',
                { error: initErr instanceof Error ? initErr.message : String(initErr) },
                LogComponent.DB,
              );
            }
          }

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
            // Phase 1 sweep every 5 min; low-power mode raises the tick
            // floor to 5s and throttles catalogSync to 5min.
            applyLowPowerOverrides(
              { extractEveryMs: 5 * 60_000, concurrency: 2 },
              isLowPowerEnabled(),
            ),
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
    // Step 5.5: Register custom file protocol for widget image embedding
    // ============================================================
    protocol.handle('duya-file', async (request) => {
      try {
        const url = new URL(request.url);
        let filePath = decodeURIComponent(url.pathname);

        // Windows drive-letter recovery: Chromium normalizes a generated
        // `duya-file:///C:/...` (three slashes, drive in the pathname) into
        // `duya-file://c/...` (drive promoted to the URL host, colon dropped)
        // because the scheme is registered `standard`. When the host is a
        // single letter, it is the drive — put it back in front of the
        // pathname so the drive-normalization below can restore `C:\...`.
        if (process.platform === 'win32' && /^[a-zA-Z]$/.test(url.host || '')) {
          filePath = `/${url.host}:${filePath}`;
        }

        // Windows absolute paths may arrive as `/e:/...` (drive + colon) or
        // `/e/...` (git-bash/WSL style, drive letter without a colon). Normalize
        // both to `e:/...` so `readFile` resolves from the drive root. Genuine
        // Unix paths (`/home/...`) are left untouched.
        if (process.platform === 'win32' && /^\/[a-zA-Z](?:\/|:)/.test(filePath)) {
          const drive = filePath[1];
          const afterDrive = filePath.slice(2); // starts with ':' or '/'
          filePath = `${drive}:${afterDrive[0] === ':' ? afterDrive.slice(1) : afterDrive}`;
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

    // ============================================================
    // Step 7: Deferred non-critical services (plan 426 Phase 6.3)
    // ============================================================
    // Browser Daemon and the CLI API server don't block first paint —
    // start them after the main window finished loading. Error handling
    // mirrors the pre-move inline blocks (unchanged).
    runAfterWindowReady(() => {
      void (async () => {
        try {
          const allowedExtensionIds = getJsonSetting<string[]>('browserExtensionAllowedIds', []);
          const normalizedExtensionIds = Array.from(new Set(
            (Array.isArray(allowedExtensionIds) ? allowedExtensionIds : [])
              .filter((id) => typeof id === 'string')
              .map((id) => id.trim())
              .filter((id) => id.length > 0),
          ));
          setAllowedExtensionIds(normalizedExtensionIds);
          // Seed the daemon with the user-configured max agent browser pages so
          // both the built-in webview backend and the extension cap applies from
          // the first command. Falls back to the default when unset.
          const storedMaxTabs = getJsonSetting<unknown>('browserMaxTabs', DEFAULT_MAX_WEBVIEW_SESSIONS);
          setBrowserMaxTabs(typeof storedMaxTabs === 'number' ? storedMaxTabs : DEFAULT_MAX_WEBVIEW_SESSIONS);
          await startBrowserDaemon();
          attachBrowserDownloadHandler();
        } catch (error) {
          logger.error('Failed to start Browser Daemon', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
        }
      })();

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
    });

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
registerIdeHandlers();
registerSettingsHandlers();
registerSkillsHandlers();
registerFilesHandlers();
registerReferencesHandlers();
registerLoggerHandlers();
registerUpdaterHandlers();
registerAgentServerHandlers();
registerDuyaLinkHandlers();
// ============================================================
// Step 4.5b: Seed + sync plugin marketplaces (Plan 455).
//
// Seeding is synchronous and offline — it only writes the default
// `official` entry into config.toml. The git sync then runs best-effort
// in the background: failures (offline, repo unavailable) leave the
// marketplace marked unsynced and the rest of startup proceeds.
// ============================================================
try {
  ensureOfficialMarketplace();
  void syncAllMarketplaces().then((outcomes) => {
    for (const outcome of outcomes) {
      if (outcome.error) {
        logger.warn(
          'Marketplace sync failed (non-fatal)',
          { marketplace: outcome.marketplace, error: outcome.error },
          'Main',
        );
      }
    }
  });
} catch (err) {
  logger.warn(
    'Marketplace seeding failed (non-fatal)',
    { error: err instanceof Error ? err.message : String(err) },
    'Main',
  );
}
registerPluginHandlers();
registerAppConnectionHandlers();
// Plan 460: register connector declarations from enabled plugins'
// `.app.json` files (idempotent; safe to run before any connection exists).
try {
  reconcilePluginAppDeclarations();
} catch (err) {
  logger.warn(
    'Plugin connector declaration reconcile failed (non-fatal)',
    { error: err instanceof Error ? err.message : String(err) },
    'Main',
  );
}
registerCapabilityManagementHandlers();
registerImportHandlers();
registerBrowserWebviewHandlers();
registerBrowserCookieHandlers();
registerGitHandlers();
registerBotChannelHandlers();
registerGroupHandlers();
registerBotHandlers();
registerMemoryListHandlers();
registerMemorySystemLogHandlers();
registerMemoryRagRebuildHandler();
registerMemoryWakeupHandlers();
registerVoiceHandlers();
registerHooksHandlers();
registerMcpReloadIpcHandler();

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

/**
 * Ensure the memory curation config root exists with default files.
 *
 * The curation staging step copies `<configRoot>` into the staging workspace,
 * so a missing `memory-config/` dir makes createStaging throw (ENOENT on
 * readdir) and fail every curation cycle. This creates the directory and
 * writes default `stage1_policy.md` + `memory_layout.json` when absent.
 * Idempotent — existing files are never overwritten.
 */
async function ensureMemoryConfigDir(configRoot: string): Promise<void> {
  fs.mkdirSync(configRoot, { recursive: true });

  const policyPath = path.join(configRoot, 'stage1_policy.md');
  if (!fs.existsSync(policyPath)) {
    // Empty policy — the full Stage 1 system prompt is just the hard contract.
    fs.writeFileSync(policyPath, '');
  }

  const layoutPath = path.join(configRoot, 'memory_layout.json');
  if (!fs.existsSync(layoutPath)) {
    const { DEFAULT_LAYOUT } = await import('../packages/agent/src/memory-state/memory_layout.js');
    const entities: Record<string, unknown> = {};
    for (const [claimType, cfg] of DEFAULT_LAYOUT.entities) {
      entities[claimType] = cfg;
    }
    fs.writeFileSync(
      layoutPath,
      JSON.stringify({ schema_version: DEFAULT_LAYOUT.schema_version, entities }, null, 2),
    );
  }
}

/**
 * Resolve the computer-use-demo daemon entry point.
 *
 * Order of attempts:
 *   1. Production: `process.resourcesPath/computer-use-demo/dist/main.js`
 *      (set up by electron-builder extraResources in a later phase).
 *   2. Dev: `E:/Projects/computer-use-demo/src/main.ts` paired with
 *      the bundled `tsx` from the repo's `node_modules`.
 *
 * Returns `{ entry, runtime }` on success, null when neither path
 * resolves. Callers should log a "daemon not available" message and
 * skip spawn rather than crashing startup.
 */
async function resolveComputerUseDaemonEntry(): Promise<
  { entry: string; runtime: string } | null
> {
  const fs = await import('node:fs/promises');
  const pathMod = await import('node:path');

  // 1. Production packaged path.
  const prodEntry = pathMod.join(
    process.resourcesPath ?? '',
    'computer-use-demo',
    'dist',
    'main.js',
  );
  try {
    await fs.access(prodEntry);
    return { entry: prodEntry, runtime: process.execPath };
  } catch {
    // not packaged; fall through
  }

  // 2. Dev path: tsx + daemon source. We honor a few common locations.
  const tsxBin = pathMod.join(
    process.cwd(),
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
  );
  const candidates = [
    'E:/Projects/computer-use-demo/src/main.ts',
    pathMod.join(process.cwd(), '..', 'computer-use-demo', 'src', 'main.ts'),
  ];
  for (const c of candidates) {
    try {
      await fs.access(c);
      try {
        await fs.access(tsxBin);
        return { entry: c, runtime: tsxBin };
      } catch {
        // no tsx; bail
        return null;
      }
    } catch {
      // try next
    }
  }
  return null;
}
