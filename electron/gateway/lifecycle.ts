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

/**
 * 串行化 reload 请求：多次快速触发会合并成一次。
 * 值为进行中 / 已排队的 reload Promise。
 */
let reloadInFlight: Promise<void> | null = null;
let reloadPending: { config: GatewayInitConfig; source: string } | null = null;

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

    // Fall through to dev path if no packaged path exists (e.g., Playwright e2e)
  }
  return path.join(process.cwd(), 'packages', 'gateway', 'dist', 'index.js');
}

export function stopGatewayProcess(): Promise<void> {
  stopRequested = true;
  return new Promise((resolve) => {
    if (!gatewayProcess || gatewayProcess.killed) {
      gatewayProcess = null;
      resolve();
      return;
    }

    const proc = gatewayProcess;
    const pid = proc.pid;
    getLogger().info('Stopping gateway process', { pid }, LogComponent.Gateway);

    // 在进程真正 exit 时 resolve；避免调用方在 SIGTERM 还在生效期间就 spawn 新进程
    proc.once('exit', () => {
      resolve();
    });

    try {
      proc.kill('SIGTERM');
    } catch (err) {
      getLogger().warn('SIGTERM failed, resolving stop', { pid, err: String(err) }, LogComponent.Gateway);
      resolve();
      return;
    }

    setTimeout(() => {
      if (gatewayProcess && !gatewayProcess.killed) {
        getLogger().warn('Gateway process did not terminate, sending SIGKILL', { pid }, LogComponent.Gateway);
        try {
          gatewayProcess.kill('SIGKILL');
        } catch { /* ignore */ }
      }
    }, 5000).unref();
  });
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
  // Log platform config at DEBUG level only. Never log credential keys or
  // values — even key names can hint at the auth scheme (e.g. "apiSecret").
  getLogger().debug(
    'Gateway platform config',
    {
      platforms: initConfig.platforms?.map(p => ({
        platform: p.platform,
        enabled: p.enabled,
        hasCredentials: !!(p.credentials && Object.keys(p.credentials).length > 0),
      })),
    },
    LogComponent.Gateway,
  );

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
      getLogger().info(`[gateway:stdout] ${line}`, undefined, LogComponent.Gateway);
    }
  });

  child.stderr!.on('data', (data: Buffer) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (!line) continue;
      // Filter out noisy Weixin session expired logs during development
      if (line.includes('[Weixin] Session expired, need to re-authenticate')) {
        continue;
      }
      getLogger().warn(`[gateway:stderr] ${line}`, undefined, LogComponent.Gateway);
    }
  });

  if (child.stdin) {
    child.stdin.write(JSON.stringify({ type: 'init', ...initConfig }) + '\n');
  }

  return child;
}

/**
 * 热重启 gateway：先 stop（等待真正退出），再用新的 init config 重启。
 *
 * 串行化语义：调用期间再次触发会把请求合并到 `reloadPending`，本次结束后立即再跑一次。
 * 这样可以避免快速多次保存设置时出现"stop 还没退出就 start"的竞态。
 */
export function reloadGatewayProcess(config: GatewayInitConfig, source: string): Promise<void> {
  // 如果已有 reload 在跑，把新请求挂到末尾
  if (reloadInFlight) {
    reloadPending = { config, source };
    return reloadInFlight;
  }

  reloadInFlight = (async () => {
    try {
      getLogger().info('Reloading gateway process', { source }, LogComponent.Gateway);
      await stopGatewayProcess();
      // startGatewayProcess 内部已经把 stopRequested 重置为 false
      startGatewayProcess(config);
    } catch (err) {
      getLogger().error('Gateway reload failed', err instanceof Error ? err : new Error(String(err)), { source }, LogComponent.Gateway);
      throw err;
    } finally {
      reloadInFlight = null;
    }
  })();

  // 排队：本次结束后，如果期间又来了新请求，再跑一次
  reloadInFlight.finally(() => {
    const pending = reloadPending;
    reloadPending = null;
    if (pending) {
      // 异步跑，不阻塞 finally 后面的代码
      reloadGatewayProcess(pending.config, pending.source).catch(() => { /* error already logged */ });
    }
  });

  return reloadInFlight;
}

/**
 * 测试/调试用：检查当前是否处于 reload 进行中或排队状态。
 */
export function isGatewayReloading(): boolean {
  return reloadInFlight !== null || reloadPending !== null;
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
