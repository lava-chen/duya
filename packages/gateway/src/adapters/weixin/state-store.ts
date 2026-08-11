/**
 * Weixin adapter persistent state.
 *
 * Persists per-account state that must survive a process restart:
 *   - context_token per peer (session continuity for outbound replies)
 *   - sync_buf (long-poll cursor, prevents message replay / loss)
 *
 * Also provides a token-level exclusive lock so two gateway instances
 * cannot poll the same iLink bot token concurrently.
 *
 * Files live under `~/.duya/gateway/weixin/` to match the rest of the
 * gateway's state layout.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface WeixinPersistedState {
  contextTokens: Record<string, string>;
  syncBuf: string;
}

function getStateDir(): string {
  const home = os.homedir();
  const dir = path.join(home, '.duya', 'gateway', 'weixin');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stateFilePath(accountId: string): string {
  return path.join(getStateDir(), `${accountId}.json`);
}

/**
 * Disk-backed store for per-account context_token map and sync_buf.
 */
export class WeixinStateStore {
  private readonly accountId: string;
  private state: WeixinPersistedState = { contextTokens: {}, syncBuf: '' };
  private dirty = false;

  constructor(accountId: string) {
    this.accountId = accountId;
    this.restore();
  }

  restore(): void {
    try {
      const filePath = stateFilePath(this.accountId);
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<WeixinPersistedState>;
      this.state = {
        contextTokens: parsed.contextTokens && typeof parsed.contextTokens === 'object' ? parsed.contextTokens : {},
        syncBuf: typeof parsed.syncBuf === 'string' ? parsed.syncBuf : '',
      };
    } catch (err) {
      // Corrupt or unreadable state is not fatal; fall back to empty.
      this.state = { contextTokens: {}, syncBuf: '' };
    }
  }

  private persist(): void {
    if (!this.dirty) return;
    try {
      const filePath = stateFilePath(this.accountId);
      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.state), 'utf-8');
      fs.renameSync(tmpPath, filePath);
      this.dirty = false;
    } catch {
      // Best-effort persistence; a failed write is not fatal.
    }
  }

  getContextToken(peerId: string): string | undefined {
    return this.state.contextTokens[peerId];
  }

  setContextToken(peerId: string, token: string): void {
    if (!token) return;
    if (this.state.contextTokens[peerId] === token) return;
    this.state.contextTokens[peerId] = token;
    this.dirty = true;
    this.persist();
  }

  clearContextToken(peerId: string): void {
    if (!(peerId in this.state.contextTokens)) return;
    delete this.state.contextTokens[peerId];
    this.dirty = true;
    this.persist();
  }

  getSyncBuf(): string {
    return this.state.syncBuf;
  }

  setSyncBuf(buf: string): void {
    if (!buf || this.state.syncBuf === buf) return;
    this.state.syncBuf = buf;
    this.dirty = true;
    this.persist();
  }

  flush(): void {
    this.persist();
  }
}

function tokenLockPath(token: string): string {
  const hash = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
  return path.join(getStateDir(), `${hash}.lock`);
}

/**
 * Acquire an exclusive lock for a bot token. Returns false when a lock file
 * already exists (i.e. another live instance is polling this token).
 */
export function acquireTokenLock(token: string): boolean {
  const lockPath = tokenLockPath(token);
  try {
    if (fs.existsSync(lockPath)) {
      return false;
    }
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx', encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

/** Release a previously acquired token lock. */
export function releaseTokenLock(token: string): void {
  try {
    const lockPath = tokenLockPath(token);
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // Best-effort cleanup.
  }
}