import { existsSync, watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import writeFileAtomic from 'write-file-atomic';
import {
  parseUserMcpToml,
  stringifyUserMcpToml,
  type UserMcpTomlServer,
} from '@duya/plugin-core/src/mcp/user-config.js';
import { app } from 'electron';
import { getLogger, LogComponent } from '../logging/logger';
import { notifyMcpConfigChanged } from './mcp-write-reload';

const logger = getLogger();
let watcher: FSWatcher | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

function resolveUserDataPath(): string {
  return process.env.DUYA_APP_DATA_PATH
    || process.env.DUYA_CLI_USER_DATA_DIR
    || (() => {
      try {
        return app.getPath('userData');
      } catch {
        return join(homedir(), '.duya');
      }
    })();
}

export function getUserMcpTomlPath(): string {
  return join(resolveUserDataPath(), 'mcp.toml');
}

export async function readUserMcpToml(): Promise<UserMcpTomlServer[]> {
  try {
    return parseUserMcpToml(await readFile(getUserMcpTomlPath(), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function writeUserMcpToml(servers: readonly UserMcpTomlServer[]): Promise<void> {
  const target = getUserMcpTomlPath();
  await mkdir(dirname(target), { recursive: true });
  await writeFileAtomic(target, stringifyUserMcpToml(servers), 'utf8');
  await notifyMcpConfigChanged();
}

/**
 * Starts one global watcher for manual edits. Programmatic writes already
 * trigger an immediate reload; the watcher covers edits outside DUYA.
 */
export function startUserMcpTomlWatcher(): void {
  if (watcher) return;
  const filePath = getUserMcpTomlPath();
  const directory = join(filePath, '..');
  try {
    watcher = watch(directory, { persistent: false }, (_event, filename) => {
      if (filename?.toString() !== 'mcp.toml') return;
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        void notifyMcpConfigChanged().catch((error: unknown) => {
          logger.warn('MCP TOML reload notification failed', {
            error: error instanceof Error ? error.message : String(error),
          }, LogComponent.AgentProcess);
        });
      }, 120);
    });
  } catch (error) {
    logger.warn('MCP TOML watcher could not start', {
      error: error instanceof Error ? error.message : String(error),
    }, LogComponent.AgentProcess);
  }
}

/** One-way migration; legacy stores never participate in runtime collection. */
export async function migrateLegacyMcpServers(
  legacySources: ReadonlyArray<readonly UserMcpTomlServer[]>,
): Promise<boolean> {
  if (existsSync(getUserMcpTomlPath())) return false;
  const seen = new Set<string>();
  const servers: UserMcpTomlServer[] = [];
  for (const source of legacySources) {
    for (const server of source) {
      if (seen.has(server.name)) continue;
      seen.add(server.name);
      servers.push(server);
    }
  }
  if (servers.length === 0) return false;
  await writeUserMcpToml(servers);
  return true;
}
