/**
 * Agent Process Pool - Process lifecycle management with resource governor.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { getConfigStore } from '../../config/store-instance';

export interface RunningProcess {
  child: ChildProcess;
  startTime: number;
  lastPong: number;
  sessionId: string;
  /**
   * Per-thread provider id. With the multi-provider model, the
   * renderer can pin a session to a specific provider via the
   * `chat:provider` message; the pool then re-initializes the
   * process with that provider instead of the global default.
   * `null` means "use the global default".
   */
  providerId: string | null;
  /**
   * Optional per-session override for the heartbeat health-check timeout
   * (ms). When unset, the pool's default (120s) applies. Long-running
   * autonomous sessions (e.g. the headless memory curator, which runs up
   * to 10 minutes) set this so the pool's health check does not kill the
   * process mid-run; the runner's own wall-clock deadline governs instead.
   */
  heartbeatTimeoutMs?: number;
}

export function calculateMaxConcurrent(): number {
  const cpuCores = os.cpus().length;
  const freeMemBytes = os.freemem();
  const freeMemGB = freeMemBytes / (1024 * 1024 * 1024);

  const baseLimit = Math.floor(cpuCores / 2);
  const memoryLimit = freeMemGB > 2 ? 4 : 2;

  const maxConcurrent = Math.min(baseLimit, memoryLimit);
  return Math.max(maxConcurrent, 1);
}

interface ElectronApp {
  isPackaged: boolean;
}

/**
 * Electron is OPTIONAL here: this module is inside the value-import closure of
 * the headless control plane's server entry
 * (`01-headless-control-plane.md` §2.1). A module-scope
 * `import { app } from 'electron'` is evaluated when the module is and throws
 * THERE, taking the whole graph with it, so `app` is resolved through a
 * guarded require.
 */
function electronApp(): ElectronApp | undefined {
  try {
    const { app } = require('electron') as { app?: ElectronApp };
    return app;
  } catch {
    return undefined;
  }
}

/**
 * A headless control plane has no packaged Electron app, so `false` is the
 * truthful answer and selects the dev-bundle candidates below — the same
 * branch a dev checkout and the Playwright e2e run already take.
 */
function isPackagedHost(): boolean {
  const app = electronApp();
  return app ? app.isPackaged : false;
}

export function getAgentProcessPath(): string {
  if (isPackagedHost()) {
    const bundled = path.join(process.resourcesPath, 'agent-bundle', 'agent-process-entry.js');
    if (fs.existsSync(bundled)) return bundled;

    const primary = path.join(process.resourcesPath, 'agent', 'process', 'agent-process-entry.js');
    if (fs.existsSync(primary)) return primary;

    const fallback = path.join(process.resourcesPath, 'agent', 'dist', 'process', 'agent-process-entry.js');
    if (fs.existsSync(fallback)) return fallback;

    // Fall through to dev path if no packaged path exists (e.g., Playwright e2e)
  }

  const devBundle = path.join(process.cwd(), 'packages', 'agent', 'bundle', 'agent-process-entry.js');
  if (fs.existsSync(devBundle)) return devBundle;

  return path.join(process.cwd(), 'packages', 'agent', 'dist', 'process', 'agent-process-entry.js');
}

export function getAgentRuntimeCommand(
  sessionId: string,
  securityBypassSkills?: string[],
  betterSqlite3Path?: string
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const agentPath = getAgentProcessPath();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DUYA_AGENT_MODE: 'true',
    SESSION_ID: sessionId,
    DUYA_SECURITY_BYPASS_SKILLS: securityBypassSkills?.join(',') || '',
    // Agent tools need to reach the Browser Daemon for webview CDP commands.
    // Use the port the daemon was started on (defaults to 19825).
    DUYA_DAEMON_PORT: process.env.DUYA_DAEMON_PORT ?? '19825',
  };

  if (isPackagedHost()) {
    const packagedBetterSqlite3 = path.join(process.resourcesPath, 'better-sqlite3');
    const usePackagedBetterSqlite3 = fs.existsSync(packagedBetterSqlite3);
    return {
      command: process.execPath,
      args: [agentPath],
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
        DUYA_BETTER_SQLITE3_PATH: betterSqlite3Path || (usePackagedBetterSqlite3 ? packagedBetterSqlite3 : path.join(process.cwd(), 'node_modules', 'better-sqlite3')),
      },
    };
  }

  return {
    command: process.execPath,
    args: [agentPath],
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: '1',
      DUYA_BETTER_SQLITE3_PATH: betterSqlite3Path || path.join(process.cwd(), 'node_modules', 'better-sqlite3'),
      // Dev-only flag: lets agent internals (e.g. API traffic logger) know it is
      // safe to enable expensive diagnostics. Never set in packaged builds.
      DUYA_DEV: '1',
      // Memory setting from config.toml so isMemoryEnabled() respects user choice.
      // Only set if not already inherited from parent (explicit env var wins).
      ...(env.DUYA_MEMORY_ENABLED === undefined
        ? { DUYA_MEMORY_ENABLED: getConfigStore().getByPath('memory.memory_enabled') ? '1' : '0' }
        : {}),
    },
  };
}

export function createChildProcess(
  sessionId: string,
  securityBypassSkills?: string[]
): ChildProcess {
  const runtime = getAgentRuntimeCommand(sessionId, securityBypassSkills);
  return spawn(runtime.command, runtime.args, {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: runtime.env,
  });
}

export function isProcessAlive(proc: RunningProcess): boolean {
  return proc.child.exitCode === null;
}
