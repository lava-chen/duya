/**
 * Agent Process Pool - Process lifecycle management with resource governor.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { app } from 'electron';

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

export function getAgentProcessPath(): string {
  if (app.isPackaged) {
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
  };

  if (app.isPackaged) {
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
