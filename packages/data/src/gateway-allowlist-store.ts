import type { GatewayAllowlist } from '@duya/agent-protocol/gateway-allowlist';
import type { SqliteDatabase } from './sqlite-connection.js';

const SETTING_KEY = 'gateway_allowlist';

function parseAllowlist(raw: string | undefined): Record<string, string[]> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, string[]> = {};
    for (const [platform, users] of Object.entries(parsed)) {
      if (Array.isArray(users)) result[platform] = users.filter((user): user is string => typeof user === 'string');
    }
    return result;
  } catch {
    return {};
  }
}

/** Data-owned, atomic persistence for Gateway sender allow-list changes. */
export class GatewayAllowlistStore {
  constructor(private readonly db: SqliteDatabase) {}

  get(): GatewayAllowlist {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_KEY) as { value: string } | undefined;
    return parseAllowlist(row?.value);
  }

  isAllowed(platform: string, platformUserId: string): boolean {
    if (!platformUserId) return true;
    const entries = this.get()[platform];
    return !entries || entries.length === 0 || entries.includes(platformUserId);
  }

  add(platform: string, platformUserId: string, now = Date.now()): void {
    if (!platform || !platformUserId) return;
    this.mutate((list) => {
      const entries = list[platform] ?? [];
      if (!entries.includes(platformUserId)) list[platform] = [...entries, platformUserId];
    }, now);
  }

  remove(platform: string, platformUserId: string, now = Date.now()): void {
    if (!platform || !platformUserId) return;
    this.mutate((list) => {
      const entries = list[platform];
      if (!entries) return;
      const remaining = entries.filter((entry) => entry !== platformUserId);
      if (remaining.length > 0) list[platform] = remaining;
      else delete list[platform];
    }, now);
  }

  private mutate(update: (list: Record<string, string[]>) => void, now: number): void {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_KEY) as { value: string } | undefined;
      const list = parseAllowlist(row?.value);
      update(list);
      this.db.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(SETTING_KEY, JSON.stringify(list), now);
    });
    transaction();
  }
}
