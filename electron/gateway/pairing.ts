import { randomBytes } from 'crypto';
import { getDatabase } from '../ipc/db-handlers';
import { getLogger, LogComponent } from '../logging/logger';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_TTL_MS = 60 * 60 * 1000;
const RATE_LIMIT_MS = 10 * 60 * 1000;
const MAX_PENDING = 3;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 60 * 60 * 1000;
const FAIL_MAP_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;

export interface PendingPairing {
  code: string;
  platform: string;
  platformUserId: string;
  platformChatId: string;
  userName: string;
  createdAt: number;
  expiresAt: number;
  lastRequestAt: number;
}

export interface ApprovedUser {
  platform: string;
  platformUserId: string;
  userName: string;
  approvedAt: number;
}

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return code;
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export class PairingStore {
  private failedAttempts = new Map<string, { count: number; lockUntil: number }>();
  private lastCleanup = Date.now();

  private cleanupStaleFailures(): void {
    const now = Date.now();
    if (now - this.lastCleanup < FAIL_MAP_CLEANUP_INTERVAL_MS) return;
    this.lastCleanup = now;
    for (const [key, state] of this.failedAttempts) {
      if (now > state.lockUntil) {
        this.failedAttempts.delete(key);
      }
    }
  }

  getPending(platform: string): PendingPairing[] {
    const db = getDatabase();
    if (!db) return [];
    const now = Date.now();
    db.prepare("DELETE FROM settings WHERE key LIKE ? AND CAST(json_extract(value, '$.expiresAt') AS INTEGER) < ?")
      .run(`pairing:${platform}:%`, now);
    const rows = db.prepare(
      "SELECT value FROM settings WHERE key LIKE ?"
    ).all(`pairing:${platform}:%`) as Array<{ value: string }>;
    const result: PendingPairing[] = [];
    for (const r of rows) {
      const parsed = safeJsonParse<PendingPairing>(r.value);
      if (parsed) {
        result.push(parsed);
      } else {
        getLogger().warn('Corrupted pairing entry, skipping', { platform }, LogComponent.Gateway);
      }
    }
    return result;
  }

  listAllPending(): PendingPairing[] {
    const db = getDatabase();
    if (!db) return [];
    const now = Date.now();
    const rows = db.prepare(
      "SELECT value FROM settings WHERE key LIKE 'pairing:%' AND key NOT LIKE 'pairing:approved:%'"
    ).all() as Array<{ value: string }>;
    const result: PendingPairing[] = [];
    for (const r of rows) {
      const parsed = safeJsonParse<PendingPairing>(r.value);
      if (parsed && now <= parsed.expiresAt) {
        result.push(parsed);
      }
    }
    return result;
  }

  generateCode(
    platform: string,
    platformUserId: string,
    platformChatId: string,
    userName: string,
  ): { code: string; error?: string } {
    const now = Date.now();
    this.cleanupStaleFailures();

    const pending = this.getPending(platform);
    const userRequest = pending.find(p => p.platformUserId === platformUserId);
    if (userRequest && now - userRequest.lastRequestAt < RATE_LIMIT_MS) {
      return { code: '', error: 'rate_limited' };
    }

    if (pending.length >= MAX_PENDING) {
      return { code: '', error: 'too_many_pending' };
    }

    const rateKey = `${platform}:${platformUserId}`;
    const failState = this.failedAttempts.get(rateKey);
    if (failState && now < failState.lockUntil) {
      return { code: '', error: 'locked_out' };
    }

    const code = generateCode();
    const pairing: PendingPairing = {
      code,
      platform,
      platformUserId,
      platformChatId,
      userName,
      createdAt: now,
      expiresAt: now + CODE_TTL_MS,
      lastRequestAt: now,
    };

    const db = getDatabase();
    if (!db) {
      getLogger().error('Cannot persist pairing code: DB not available', undefined, undefined, LogComponent.Gateway);
      return { code: '', error: 'db_unavailable' };
    }
    db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(`pairing:${platform}:${platformUserId}`, JSON.stringify(pairing), now);

    getLogger().info('Pairing code generated', { platform, platformUserId }, LogComponent.Gateway);
    return { code };
  }

  approve(platform: string, code: string): { approved: boolean; error?: string } {
    const now = Date.now();
    this.cleanupStaleFailures();
    const pending = this.getPending(platform);
    const match = pending.find(p => p.code === code);

    if (!match) {
      this.recordFailedAttempt(platform, code);
      return { approved: false, error: 'invalid_code' };
    }

    if (now > match.expiresAt) {
      return { approved: false, error: 'expired' };
    }

    const rateKey = `${platform}:${match.platformUserId}`;
    const failState = this.failedAttempts.get(rateKey);
    if (failState && now < failState.lockUntil) {
      return { approved: false, error: 'locked_out' };
    }

    const db = getDatabase();
    if (db) {
      const approved: ApprovedUser = {
        platform: match.platform,
        platformUserId: match.platformUserId,
        userName: match.userName,
        approvedAt: now,
      };
      db.prepare(`
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(`pairing:approved:${platform}:${match.platformUserId}`, JSON.stringify(approved), now);

      db.prepare("DELETE FROM settings WHERE key = ?").run(`pairing:${platform}:${match.platformUserId}`);
      this.failedAttempts.delete(rateKey);
    }

    getLogger().info('Pairing approved', { platform, platformUserId: match.platformUserId }, LogComponent.Gateway);
    return { approved: true };
  }

  isApproved(platform: string, platformUserId: string): boolean {
    const db = getDatabase();
    if (!db) return false;
    const row = db.prepare(
      "SELECT value FROM settings WHERE key = ?"
    ).get(`pairing:approved:${platform}:${platformUserId}`) as { value: string } | undefined;
    return !!row;
  }

  listApproved(platform?: string): ApprovedUser[] {
    const db = getDatabase();
    if (!db) return [];
    const pattern = platform ? `pairing:approved:${platform}:%` : 'pairing:approved:%';
    const rows = db.prepare(
      "SELECT value FROM settings WHERE key LIKE ?"
    ).all(pattern) as Array<{ value: string }>;
    const result: ApprovedUser[] = [];
    for (const r of rows) {
      const parsed = safeJsonParse<ApprovedUser>(r.value);
      if (parsed) {
        result.push(parsed);
      }
    }
    return result;
  }

  recordFailedAttempt(platform: string, platformUserId: string): void {
    const rateKey = `${platform}:${platformUserId}`;
    const state = this.failedAttempts.get(rateKey) || { count: 0, lockUntil: 0 };
    state.count++;
    if (state.count >= MAX_FAILED_ATTEMPTS) {
      state.lockUntil = Date.now() + LOCKOUT_DURATION_MS;
      getLogger().warn('Pairing locked out after max failed attempts', { platform, platformUserId, count: state.count }, LogComponent.Gateway);
    }
    this.failedAttempts.set(rateKey, state);
  }

  revoke(platform: string, platformUserId: string): boolean {
    const db = getDatabase();
    if (!db) return false;
    const key = `pairing:approved:${platform}:${platformUserId}`;
    const result = db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    return result.changes > 0;
  }
}

let pairingStore: PairingStore | null = null;
export function getPairingStore(): PairingStore {
  if (!pairingStore) pairingStore = new PairingStore();
  return pairingStore;
}