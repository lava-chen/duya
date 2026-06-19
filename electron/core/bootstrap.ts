import { app } from 'electron';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { initLogger, getLogger, LogComponent } from '../logging/logger';

const logger = initLogger({ level: 'WARN' });

export const isTestMode = process.env.DUYA_TEST === '1';
// app.isPackaged returns true when Playwright _electron launches the Electron
// binary directly, even in dev. Treat test mode as dev so setupDevMode(),
// getRendererUrl(), and other isDev-gated paths work correctly.
export const isDev = !app.isPackaged || isTestMode;
export const isPreviewMode = process.env.DUYA_PREVIEW_MODE === 'true';
export const DEBUG_IPC = process.env.DUYA_DEBUG_IPC === 'true';

// =============================================================================
// Test Mode — activated by DUYA_TEST=1 env var.
// See e2e/helpers.ts → launchDuya() for how Playwright drives this.
// =============================================================================

/**
 * Parse --duya-namespace=<name> or --duya-namespace <name> from argv.
 * Returns null if not present or invalid. Playwright passes args with
 * `=` (e.g. `--duya-namespace=smoke`), while manual CLI use may pass
 * them as two separate tokens — both forms are accepted.
 */
export function getTestNamespace(): string | null {
  if (!isTestMode) return null;
  // Form 1: --duya-namespace=value
  for (const arg of process.argv) {
    if (arg.startsWith('--duya-namespace=')) {
      const ns = arg.slice('--duya-namespace='.length);
      return ns && /^[a-zA-Z0-9_-]+$/.test(ns) ? ns : null;
    }
  }
  // Form 2: --duya-namespace value (two separate tokens)
  const idx = process.argv.indexOf('--duya-namespace');
  if (idx >= 0 && idx + 1 < process.argv.length) {
    const ns = process.argv[idx + 1];
    return ns && /^[a-zA-Z0-9_-]+$/.test(ns) ? ns : null;
  }
  return null;
}

/**
 * In test mode, override userData to a per-namespace subdirectory so each
 * spec gets an isolated SQLite database, settings, and lockfile. Runs
 * AFTER setupDevMode() so test isolation takes precedence over dev mode.
 */
export function setupTestMode(): void {
  if (!isTestMode) return;
  const ns = getTestNamespace();
  if (!ns) return;
  // Honor an explicit override if the caller pre-created a writable
  // directory (useful in restricted CI/sandbox environments where the
  // default AppData path is blocked from new writes). The caller is
  // responsible for ensuring the directory exists and is empty if a
  // fresh DB is desired.
  const overrideDir = process.env.DUYA_TEST_USER_DATA_DIR;
  const testUserData = overrideDir
    ? path.resolve(overrideDir)
    : path.join(app.getPath('userData'), 'test-namespaces', ns);
  if (!overrideDir) {
    // Default path: ensure the directory exists. app.setPath() does not
    // create it, and initDatabaseFromBoot() will fail otherwise.
    fs.mkdirSync(testUserData, { recursive: true });
  }
  app.setPath('userData', testUserData);
  getLogger().info(
    `Test mode: isolated userData at ${testUserData}`,
    undefined,
    LogComponent.Main,
  );
}

export function debugLog(...args: unknown[]): void {
  if (DEBUG_IPC) {
    logger.debug(args.join(' '), { source: 'Main' });
  }
}

// =============================================================================
// Environment Diagnostic — logs key paths and mode at startup
// =============================================================================

export function logEnvironmentDiagnostic(): void {
  const resPath = app.isPackaged ? process.resourcesPath : process.cwd();
  const userDataPath = app.getPath('userData');
  const exePath = process.execPath;

  const log = getLogger();
  log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', undefined, LogComponent.Main);
  log.info('DUYA Environment Diagnostic', undefined, LogComponent.Main);
  log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', undefined, LogComponent.Main);
  log.info(`  Mode:         ${app.isPackaged ? 'PACKAGED' : isPreviewMode ? 'PREVIEW' : 'DEVELOPMENT'}`, undefined, LogComponent.Main);
  log.info(`  Platform:     ${process.platform} ${os.arch()}`, undefined, LogComponent.Main);
  log.info(`  Electron:     ${process.versions.electron}`, undefined, LogComponent.Main);
  log.info(`  Node:         ${process.versions.node}`, undefined, LogComponent.Main);
  log.info(`  ExecPath:     ${exePath}`, undefined, LogComponent.Main);
  log.info(`  Resources:    ${resPath}`, undefined, LogComponent.Main);
  log.info(`  UserData:     ${userDataPath}`, undefined, LogComponent.Main);
  log.info(`  CWD:          ${process.cwd()}`, undefined, LogComponent.Main);
  log.info(`  ENV VITE:     VITE_DEV_SERVER_URL=${process.env.VITE_DEV_SERVER_URL || 'unset'}`, undefined, LogComponent.Main);
  log.info(`  ENV LOG_LEVEL: ${process.env.LOG_LEVEL || 'unset'}`, undefined, LogComponent.Main);
  log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', undefined, LogComponent.Main);
}

// =============================================================================
// Development Mode: Use isolated userData directory
// =============================================================================

export function setupDevMode(): void {
  if (isDev && !isPreviewMode) {
    const originalUserData = app.getPath('userData');
    const devUserData = path.join(originalUserData, 'duya-dev');
    app.setPath('userData', devUserData);
    getLogger().info(`Dev mode: using isolated userData at ${devUserData}`, undefined, LogComponent.Main);
  }
}

// =============================================================================
// Global Error Handlers
// =============================================================================

export function initGlobalErrorHandlers(): void {
  process.on('uncaughtException', (error) => {
    // EADDRINUSE can be thrown asynchronously from net.Server.setupListenHandle
    // (via process.nextTick) when two startup paths race for the same port —
    // for example, the browser daemon's listen fires before the per-call
    // .once('error') handler is attached. Log it as a warning and let the
    // owning subsystem's self-healing path reclaim the port; do NOT
    // propagate this as a fatal error.
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'EADDRINUSE') {
      logger.warn(
        'EADDRINUSE caught at process level — subsystem will self-heal',
        { message: error?.message },
        LogComponent.Main,
      );
      return;
    }

    logger.error('Uncaught Exception', error, undefined, LogComponent.Main);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Rejection', reason instanceof Error ? reason : new Error(String(reason)), undefined, LogComponent.Main);
  });
}

// =============================================================================
// Step 0: Single Instance Lock
// =============================================================================

export function acquireSingleInstanceLock(): boolean {
  // Test mode: skip single-instance lock so Playwright can launch multiple
  // isolated Electron processes (each with its own namespaced userData)
  // without conflicting with a dev instance or a previous test run.
  if (isTestMode) {
    getLogger().info(
      'Test mode: skipping single-instance lock',
      undefined,
      LogComponent.Main,
    );
    return true;
  }
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    app.quit();
    return false;
  }
  return true;
}

export function setupSecondInstanceHandler(onSecondInstance: () => void): void {
  app.on('second-instance', onSecondInstance);
}
