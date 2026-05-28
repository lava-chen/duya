import path from 'path';
import fs from 'fs';
import { ChildProcess, spawn } from 'child_process';
import { app } from 'electron';
import { getLogger, LogComponent } from '../logging/logger';
import { GatewayInitConfig } from './types';

const BACKOFF_MAX_MS = 5_000;
const RESTART_DELAY_MS = 3_000;
const MAX_RESTARTS_PER_WINDOW = 5;

let gatewayProcess: ChildProcess | null = null;
let restartCount = 0;
let restartWindowStart = 0;
let backoffMs = RESTART_DELAY_MS;
let stopRequested = false;

export function getGatewayProcess(): ChildProcess | null {
  return gatewayProcess;
}

export function isGatewayRunning(): boolean {
  return gatewayProcess !== null && !gatewayProcess.killed;
}

function getGatewayProcessPath(): string {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'gateway-bundle', 'gateway-process-entry.js');
    if (fs.existsSync(bundled)) return bundled;

    const alt = path.join(process.resourcesPath, 'gateway', 'index.js');
    if (fs.existsSync(alt)) return alt;

    const asarPath = path.join(process.resourcesPath, 'app.asar', 'dist-electron', 'gateway.js');
    if (fs.existsSync(asarPath)) return asarPath;

    return bundled;
  }
  return path.join(process.cwd(), 'packages', 'gateway', 'dist', 'index.js');
}

export function stopGatewayProcess(): void {
  stopRequested = true;
  if (!gatewayProcess || gatewayProcess.killed) {
    gatewayProcess = null;
    return;
  }

  const pid = gatewayProcess.pid;
  getLogger().info('Stopping gateway process', { pid }, LogComponent.Gateway);
  gatewayProcess.kill('SIGTERM');

  setTimeout(() => {
    if (gatewayProcess && !gatewayProcess.killed) {
      getLogger().warn('Gateway process did not terminate, sending SIGKILL', { pid }, LogComponent.Gateway);
      gatewayProcess.kill('SIGKILL');
    }
  }, 5000).unref();
}

function onGatewayExit(
  code: number | null,
  signal: string | null,
  onRestart: () => void,
): void {
  const pid = gatewayProcess?.pid;
  getLogger().error('Gateway process exited', new Error(`Exit code: ${code}, signal: ${signal}`), { pid, code, signal }, LogComponent.Gateway);

  gatewayProcess = null;

  if (stopRequested) {
    getLogger().info('Gateway stop was requested, not restarting', undefined, LogComponent.Gateway);
    return;
  }

  const now = Date.now();
  if (now - restartWindowStart > 60_000) {
    restartWindowStart = now;
    restartCount = 0;
  }

  if (restartCount >= MAX_RESTARTS_PER_WINDOW) {
    getLogger().error(
      'Max restarts per window reached, giving up',
      new Error(`Max restarts: ${MAX_RESTARTS_PER_WINDOW}`),
      { restartCount, MAX_RESTARTS_PER_WINDOW },
      LogComponent.Gateway,
    );
    return;
  }

  restartCount++;
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);

  getLogger().info(`Restarting gateway in ${backoffMs}ms (attempt ${restartCount}/${MAX_RESTARTS_PER_WINDOW})`, undefined, LogComponent.Gateway);
  setTimeout(onRestart, backoffMs);
}

export function startGatewayProcess(initConfig: GatewayInitConfig): ChildProcess {
  const gatewayPath = getGatewayProcessPath();
  const agentServerPort = initConfig.agentServerPort ?? (process.env.DUYA_AGENT_SERVER_PORT ? parseInt(process.env.DUYA_AGENT_SERVER_PORT, 10) : 0);
  getLogger().info('Starting gateway process', { path: gatewayPath, platforms: initConfig.platforms?.length ?? 0 }, LogComponent.Gateway);
  console.log('[STARTUP] startGatewayProcess: platforms =', JSON.stringify(initConfig.platforms?.map(p => ({ platform: p.platform, enabled: p.enabled, hasCredentials: !!(p.credentials && Object.keys(p.credentials).length > 0), credentialsKeys: Object.keys(p.credentials || {}) }))));

  if (!fs.existsSync(gatewayPath)) {
    const err = new Error(`Gateway entry not found: ${gatewayPath}`);
    getLogger().error('Gateway entry not found', err, { gatewayPath }, LogComponent.Gateway);
    throw err;
  }

  if (gatewayProcess && !gatewayProcess.killed) {
    getLogger().info('Gateway already running, stopping first', undefined, LogComponent.Gateway);
    stopGatewayProcess();
  }

  stopRequested = false;
  backoffMs = RESTART_DELAY_MS;

  const envVars: Record<string, string> = {
    DUYA_GATEWAY_TEMP_DIR: initConfig.tempDir || process.env.DUYA_GATEWAY_TEMP_DIR || '',
    DUYA_GATEWAY_WORKER_TEMP_DIR: initConfig.gatewayWorkerTempDir || process.env.DUYA_GATEWAY_WORKER_TEMP_DIR || '',
    DUYA_AGENT_SERVER_PORT: String(agentServerPort || process.env.DUYA_AGENT_SERVER_PORT || '0'),
    NODE_ENV: process.env.NODE_ENV || 'production',
    ELECTRON_RUN_AS_NODE: '1',
  };

  if (initConfig.platforms && initConfig.platforms.length > 0) {
    envVars.DUYA_PLATFORMS = JSON.stringify(initConfig.platforms);
  }

  if (initConfig.workerSpawnConfig?.agentProcessEntry) {
    envVars.DUYA_AGENT_PROCESS_ENTRY = initConfig.workerSpawnConfig.agentProcessEntry;
  }

  if (initConfig.workerSpawnConfig?.betterSqlite3Path) {
    envVars.DUYA_BETTER_SQLITE3_PATH = initConfig.workerSpawnConfig.betterSqlite3Path;
  } else if (process.env.DUYA_BETTER_SQLITE3_PATH) {
    envVars.DUYA_BETTER_SQLITE3_PATH = process.env.DUYA_BETTER_SQLITE3_PATH;
  }

  const child = spawn(process.execPath, [gatewayPath], {
    env: { ...process.env, ...envVars },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });

  gatewayProcess = child;

  child.on('exit', (code, signal) => {
    onGatewayExit(code, signal, () => {
      startGatewayProcess(initConfig);
    });
  });

  child.on('error', (err) => {
    getLogger().error('Failed to start gateway', err, { pid: child.pid }, LogComponent.Gateway);
  });

  child.stdout!.on('data', (data: Buffer) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (!line) continue;
      console.log(`[gateway:stdout] ${line}`);
      getLogger().info(`[gateway:stdout] ${line}`, undefined, LogComponent.Gateway);
    }
  });

  child.stderr!.on('data', (data: Buffer) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (!line) continue;
      console.error(`[gateway:stderr] ${line}`);
      getLogger().warn(`[gateway:stderr] ${line}`, undefined, LogComponent.Gateway);
    }
  });

  if (child.stdin) {
    child.stdin.write(JSON.stringify({ type: 'init', ...initConfig }) + '\n');
  }

  return child;
}

export function waitForGatewayReady(
  initConfig: GatewayInitConfig,
  child: ChildProcess,
  timeoutMs: number = 30_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Gateway startup timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const onReady = (msg: Record<string, unknown>) => {
      if (msg.type === 'gateway:ready' || msg.type === 'gateway:init:complete') {
        clearTimeout(timer);
        child.removeListener('message', onReady);
        resolve();
      }
    };

    child.on('message', onReady);

    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Gateway exited during startup with code ${code}`));
    });
  });
}
