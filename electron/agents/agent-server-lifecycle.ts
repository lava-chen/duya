import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { getLogger, LogComponent } from '../logging/logger';
import { handleDbRequest } from './db-bridge';
import { killProcessTree } from '../lib/process-cleanup';

let agentServerPort: number | null = null;
let agentServerProcess: ChildProcess | null = null;
let restartBackoff = 1000;
const MAX_BACKOFF = 30000;
const BACKOFF_MULTIPLIER = 2;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let isShuttingDown = false;

function getAgentServerPath(): string {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'agent-server.js');
    if (fs.existsSync(bundled)) return bundled;

    const alt = path.join(process.resourcesPath, 'dist-electron', 'agent-server.js');
    if (fs.existsSync(alt)) return alt;

    return bundled;
  }

  return path.join(process.cwd(), 'dist-electron', 'agent-server.js');
}

export function spawnAgentServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    if (agentServerProcess && !agentServerProcess.killed) {
      resolve(agentServerPort!);
      return;
    }

    const serverPath = getAgentServerPath();
    const logger = getLogger();

    if (!fs.existsSync(serverPath)) {
      const err = new Error(`Agent Server entry not found: ${serverPath}`);
      logger.error('Agent Server entry not found', err, { serverPath }, LogComponent.Main);
      reject(err);
      return;
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DUYA_AGENT_SERVER: 'true',
    };

    let command: string;
    let args: string[];

    command = process.execPath;
    args = [serverPath];
    env.ELECTRON_RUN_AS_NODE = '1';

    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env,
    });

    let settled = false;
    let stdoutBuffer = '';

    child.on('message', (msg: any) => {
      if (msg.type === 'db:request') {
        handleDbRequest(msg).then((response) => {
          if (!child.killed) {
            child.send(response);
          }
        }).catch((error) => {
          getLogger().error('handleDbRequest failed for Agent Server', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Main);
        });
      }
    });

    child.stdout?.on('data', (data: Buffer) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Log debug output to file only
        logger.debug(`[agent-server-lifecycle] stdout: ${trimmed}`, undefined, LogComponent.Main);

        try {
          const parsed = JSON.parse(trimmed);

          // Startup handshake: port announcement
          if (!settled && parsed.port && typeof parsed.port === 'number') {
            agentServerPort = parsed.port;
            agentServerProcess = child;
            restartBackoff = 1000;
            settled = true;
            resolve(parsed.port);
            continue;
          }

          // Agent server logs (distinguished by component field)
          if (parsed.component && typeof parsed.component === 'string') {
            const msg = parsed.msg as string;
            const data = parsed.data;
            const level = parsed.level as string;

            // Always output agent-server logs at INFO level for debugging
            if (level === 'error') {
              logger.error(`[agent-server] ${msg}`, data ? new Error(JSON.stringify(data)) : undefined, data, LogComponent.Main);
            } else if (level === 'warn') {
              logger.warn(`[agent-server] ${msg}`, data, LogComponent.Main);
            } else {
              // info and debug both go to info
              logger.info(`[agent-server] ${msg}`, data, LogComponent.Main);
            }
          }
        } catch {
          // Not JSON — ignore
        }
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (!line) return;

      // Also output to console for debugging
      console.error(`[agent-server] ${line}`);

      // Classify stderr lines properly — most stderr from the agent server
      // is forwarded worker output (INFO-level), not actual errors.
      const isError =
        line.includes('Error:') ||
        line.includes('[ERROR]') ||
        line.includes('[FATAL]') ||
        line.includes('TypeError') ||
        line.includes('ReferenceError') ||
        line.includes('uncaughtException');
      const isWarn =
        line.includes('[WARN]') ||
        line.includes('[WARNING]');

      if (isError) {
        logger.error(`Agent Server error: ${line}`, undefined, undefined, LogComponent.Main);
      } else if (isWarn) {
        logger.warn(`Agent Server: ${line}`, undefined, LogComponent.Main);
      } else {
        logger.info(`Agent Server: ${line}`, undefined, LogComponent.Main);
      }
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        logger.error('Agent Server spawn error', err, undefined, LogComponent.Main);
        reject(err);
      }
    });

    child.on('exit', (code, signal) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Agent Server exited immediately with code ${code}, signal ${signal}`));
      }

      // Flush any remaining stdout data before clearing state
      if (stdoutBuffer.trim()) {
        try {
          const parsed = JSON.parse(stdoutBuffer.trim());
          if (parsed.component && typeof parsed.component === 'string') {
            const msg = parsed.msg as string;
            const level = parsed.level as string;
            if (level === 'error') {
              logger.error(`[agent-server] ${msg}`, undefined, undefined, LogComponent.Main);
            } else if (level === 'warn') {
              logger.warn(`[agent-server] ${msg}`, undefined, LogComponent.Main);
            } else {
              logger.info(`[agent-server] ${msg}`, undefined, LogComponent.Main);
            }
          }
        } catch {
          // Last buffer line was not valid JSON
        }
      }

      agentServerProcess = null;
      agentServerPort = null;

      if (!isShuttingDown) {
        scheduleRestart();
      }
    });

    const startupTimeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        logger.error('Agent Server startup timeout after 15s, killing', undefined, undefined, LogComponent.Main);
        killProcessTree(child, { force: true });
        reject(new Error('Agent Server startup timeout'));
      }
    }, 15000);

    child.on('exit', () => {
      clearTimeout(startupTimeout);
    });
  });
}

function scheduleRestart(): void {
  if (restartTimer) return;

  const delay = restartBackoff;
  restartBackoff = Math.min(restartBackoff * BACKOFF_MULTIPLIER, MAX_BACKOFF);

  restartTimer = setTimeout(() => {
    restartTimer = null;
    spawnAgentServer().catch((err) => {
      getLogger().error('Agent Server restart failed', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
    });
  }, delay);
}

export function getAgentServerPort(): number | null {
  return agentServerPort;
}

export function isAgentServerRunning(): boolean {
  return agentServerProcess !== null && !agentServerProcess.killed;
}

export async function stopAgentServer(): Promise<void> {
  isShuttingDown = true;

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  if (!agentServerProcess) return;

  const child = agentServerProcess;
  agentServerProcess = null;
  agentServerPort = null;

  return killProcessTree(child, { force: true, timeoutMs: 5000 });
}