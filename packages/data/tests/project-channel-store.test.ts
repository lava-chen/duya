/**
 * project-channel-store.test.ts — the contract invariants that must hold on a
 * REAL SQLite database (no in-memory fake store).
 *
 * Mirrors the plan's acceptance matrix for slice A: unique Bot identity across
 * Projects, binding ownership + revision CAS, inbound dedup and body conflicts,
 * Delivery idempotency / unknown status, and old-database upgrade and rollback
 * safety. Every write that claims idempotency is retried with a different minted
 * id to prove the STORE, not the caller, enforced it.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  inboundDedupKey,
  deliveryRequestKey,
} from '@duya/agent-protocol/project-channels';
import {
  PROJECT_CHANNEL_MIGRATIONS,
  ProjectChannelStore,
  ProjectChannelStoreError,
} from '../src/project-channel-store.js';

let db: Database.Database;
let store: ProjectChannelStore;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'duya-project-channels-'));
  db = new Database(join(dir, 'core.db'));
  for (const migration of PROJECT_CHANNEL_MIGRATIONS) migration.up(db);
  store = new ProjectChannelStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function expectCode(code: string, fn: () => unknown): void {
  try {
    fn();
    throw new Error(`expected ${code} to be thrown`);
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectChannelStoreError);
    expect((error as ProjectChannelStoreError).code).toBe(code);
  }
}

const CONN_A = {
  connectionId: 'conn-a', projectId: 'project-a', requestId: 'cfg-a',
  botUserId: 'bot-aaaa', label: 'Alpha', now: 1_000,
};
const CONN_B = {
  connectionId: 'conn-b', projectId: 'project-b', requestId: 'cfg-b',
  botUserId: 'bot-bbbb', label: 'Beta', now: 1_000,
};

function bind(overrides: Partial<Parameters<ProjectChannelStore['createBinding']>[0]> = {}) {
  return {
    bindingId: 'binding-1', projectId: 'project-a', requestId: 'bind-1',
    connectionId: 'conn-a', guildId: 'guild-1', channelId: 'channel-1',
    allowedUserIds: ['user-1'], now: 2_000, ...overrides,
  };
}

describe('connection identity and configuration', () => {
  it('stores only client-safe facts and starts enabled at revision 1', () => {
    const { record } = store.createConnection(CONN_A);
    expect(record.botUserId).toBe('bot-aaaa');
    expect(record.credentialConfigured).toBe(true);
    expect(record.enabled).toBe(true);
    expect(record.revision).toBe(1);
    expect(record.generation).toBe(0);
    expect(JSON.stringify(record)).not.toContain('token');
  });

  it('is idempotent by (project, requestId) with a different minted id', () => {
    const first = store.createConnection(CONN_A);
    const retry = store.createConnection({ ...CONN_A, connectionId: 'conn-a-retry' });
    expect(retry.deduplicated).toBe(true);
    expect(retry.record.connectionId).toBe(first.record.connectionId);
    expect(store.listConnections('project-a')).toHaveLength(1);
  });

  it('refuses the same bot identity for a different project', () => {
    store.createConnection(CONN_A);
    expectCode('bot_identity_conflict', () =>
      store.createConnection({ ...CONN_B, botUserId: CONN_A.botUserId }));
    expect(store.getActiveConnectionForProject('project-b')).toBeNull();
  });

  it('allows only one active connection per project', () => {
    store.createConnection(CONN_A);
    expectCode('connection_exists', () =>
      store.createConnection({ ...CONN_A, requestId: 'cfg-a-2', botUserId: 'bot-other', connectionId: 'conn-a-2' }));
  });

  it('refuses a stale config CAS without applying it', () => {
    const { record } = store.createConnection(CONN_A);
    store.rotateConnection({ connectionId: record.connectionId, expectedRevision: 1, botUserId: 'bot-aaaa', now: 1_100 });
    expectCode('stale_revision', () =>
      store.rotateConnection({ connectionId: record.connectionId, expectedRevision: 1, botUserId: 'bot-aaaa' }));
    expect(store.getConnection(record.connectionId)!.revision).toBe(2);
  });

  it('disconnect is CAS and idempotent, and keeps the audit row', () => {
    const { record } = store.createConnection(CONN_A);
    const revoked = store.disconnectConnection({
      connectionId: record.connectionId, requestId: 'disc-1', expectedRevision: 1, now: 1_200,
    });
    expect(revoked!.enabled).toBe(false);
    const replay = store.disconnectConnection({
      connectionId: record.connectionId, requestId: 'disc-1', expectedRevision: 1,
    });
    expect(replay!.connectionId).toBe(record.connectionId);
    expect(store.listConnections('project-a')).toHaveLength(1);
    expect(store.getActiveConnection(record.connectionId)).toBeNull();
    expectCode('connection_disabled', () => store.advanceGeneration(record.connectionId));
  });
});

describe('binding ownership and revision CAS', () => {
  it('requires a non-empty allowlist and an active connection in the same project', () => {
    store.createConnection(CONN_A);
    expectCode('invalid_allowlist', () => store.createBinding(bind({ allowedUserIds: [] })));
    expectCode('connection_not_found', () => store.createBinding(bind({ connectionId: 'conn-missing' })));
    expectCode('connection_not_found', () => store.createBinding(bind({ projectId: 'project-b' })));
  });

  it('is idempotent by request key and refuses double active binding of one channel', () => {
    store.createConnection(CONN_A);
    const first = store.createBinding(bind());
    const retry = store.createBinding(bind({ bindingId: 'binding-retry', allowedUserIds: ['user-1', 'user-1'] }));
    expect(retry.deduplicated).toBe(true);
    expect(retry.record.bindingId).toBe(first.record.bindingId);
    expect(retry.record.allowedUserIds).toEqual(['user-1']);
    expectCode('binding_conflict', () =>
      store.createBinding(bind({ bindingId: 'binding-2', requestId: 'bind-2' })));
  });

  it('refuses a stale patch and cannot re-enable a revoked binding', () => {
    store.createConnection(CONN_A);
    const { record } = store.createBinding(bind());
    const patched = store.updateBinding({
      projectId: 'project-a', bindingId: record.bindingId, requestId: 'patch-1',
      expectedRevision: 1, allowProactive: true, now: 2_100,
    });
    expect(patched!.allowProactive).toBe(true);
    expect(patched!.revision).toBe(2);
    expectCode('stale_revision', () => store.updateBinding({
      projectId: 'project-a', bindingId: record.bindingId, requestId: 'patch-stale',
      expectedRevision: 1, allowProactive: false,
    }));
    store.revokeBinding({
      projectId: 'project-a', bindingId: record.bindingId, requestId: 'revoke-1',
      expectedRevision: 2, now: 2_200,
    });
    expectCode('binding_revoked', () => store.updateBinding({
      projectId: 'project-a', bindingId: record.bindingId, requestId: 'patch-after',
      expectedRevision: 3, allowProactive: false,
    }));
  });
});

describe('inbound dedup and conflict', () => {
  const inbound = (overrides: Partial<Parameters<ProjectChannelStore['acceptInbound']>[0]> = {}) => ({
    inboundId: 'inbound-1', connectionId: 'conn-a', generation: 1,
    bindingId: 'binding-1', bindingRevision: 1,
    body: {
      platformMessageId: 'msg-1', guildId: 'guild-1', channelId: 'channel-1',
      senderId: 'user-1', mentionIds: ['bot-aaaa'], text: '@bot status?', receivedAt: 3_000,
    },
    now: 3_000, ...overrides,
  });

  it('persists the body and composes the stable dedup key', () => {
    const { record } = store.acceptInbound(inbound());
    expect(record.dedupKey).toBe(inboundDedupKey('conn-a', 'msg-1'));
    expect(record.bodyFingerprint).toMatch(/^pc1:/);
    expect(record.inputId).toBeNull();
    expect(store.getInboundByDedup('conn-a', 'msg-1')!.inboundId).toBe('inbound-1');
  });

  it('redelivery returns the original, and a changed body is a hard conflict', () => {
    const first = store.acceptInbound(inbound());
    const dup = store.acceptInbound(inbound({ inboundId: 'inbound-dup' }));
    expect(dup.deduplicated).toBe(true);
    expect(dup.record.inboundId).toBe(first.record.inboundId);
    expectCode('inbound_fingerprint_conflict', () => store.acceptInbound(inbound({
      inboundId: 'inbound-evil', body: { ...inbound().body, text: '@bot pay owner' },
    })));
    expect(store.getInbound('inbound-1')!.text).toBe('@bot status?');
  });

  it('scopes dedup to the connection, not just the platform message id', () => {
    store.acceptInbound(inbound());
    const other = store.acceptInbound(inbound({
      inboundId: 'inbound-conn-b', connectionId: 'conn-b',
    }));
    expect(other.deduplicated).toBe(false);
    expect(other.record.dedupKey).not.toBe(inboundDedupKey('conn-a', 'msg-1'));
  });

  it('attaches the accepted input exactly once', () => {
    store.acceptInbound(inbound());
    const attached = store.attachInput({
      inboundId: 'inbound-1', inputId: 'input-1', targetSessionId: 'session-1',
    });
    expect(attached.inputId).toBe('input-1');
    expect(attached.targetSessionId).toBe('session-1');
    expectCode('request_conflict', () => store.attachInput({
      inboundId: 'inbound-1', inputId: 'input-2', targetSessionId: 'session-2',
    }));
  });
});

describe('delivery idempotency and statuses', () => {
  const delivery = (overrides: Partial<Parameters<ProjectChannelStore['createDelivery']>[0]> = {}) => ({
    deliveryId: 'delivery-1', projectId: 'project-a', bindingId: 'binding-1',
    bindingRevision: 1, connectionId: 'conn-a', connectionRevision: 1,
    sessionId: 'session-1', requestId: 'send-1',
    body: { bindingId: 'binding-1', text: 'hello', replyToInboundId: null },
    now: 4_000, ...overrides,
  });

  it('queues a durable obligation and never reports queued as sent', () => {
    const { record } = store.createDelivery(delivery());
    expect(record.status).toBe('queued');
    expect(record.platformMessageId).toBeNull();
    expect(record.requestId).toBe('send-1');
    expect(deliveryRequestKey('project-a', 'send-1')).toMatch(/project-a\u0000send-1/);
  });

  it('is idempotent by (project, requestId) and refuses a changed body', () => {
    store.createDelivery(delivery());
    const retry = store.createDelivery(delivery({ deliveryId: 'delivery-dup' }));
    expect(retry.deduplicated).toBe(true);
    expect(retry.record.deliveryId).toBe('delivery-1');
    expectCode('delivery_conflict', () => store.createDelivery(delivery({
      deliveryId: 'delivery-evil', body: { bindingId: 'binding-1', text: '@everyone', replyToInboundId: null },
    })));
  });

  it('claims once and records unknown without auto-resending', () => {
    store.createDelivery(delivery());
    expect(store.claimDelivery('delivery-1', 4_100)!.status).toBe('sending');
    expect(store.claimDelivery('delivery-1', 4_200)).toBeNull();
    const unknown = store.settleDelivery({
      deliveryId: 'delivery-1', status: 'unknown', reason: 'network_timeout', now: 4_300,
    });
    expect(unknown!.status).toBe('unknown');
    expect(store.getDelivery('delivery-1')!.platformMessageId).toBeNull();
    expect(store.claimDelivery('delivery-1', 4_400)).toBeNull();
  });

  it('records a real platform receipt as sent', () => {
    store.createDelivery(delivery());
    store.claimDelivery('delivery-1', 4_100);
    const sent = store.settleDelivery({
      deliveryId: 'delivery-1', status: 'sent', platformMessageId: 'platform-9', now: 4_500,
    });
    expect(sent!.status).toBe('sent');
    expect(sent!.platformMessageId).toBe('platform-9');
  });

  it('paginates by creation cursor', () => {
    store.createDelivery(delivery());
    store.createDelivery(delivery({ deliveryId: 'delivery-2', requestId: 'send-2', now: 5_000 }));
    const page = store.listDeliveries('project-a', 0, 1);
    expect(page.deliveries).toHaveLength(1);
    expect(page.nextCursor).toBe(4_000);
    expect(store.listDeliveries('project-a', page.nextCursor!, 10).deliveries).toHaveLength(1);
  });
});

describe('runtime observation and migration safety', () => {
  it('keeps observation separate from persisted config and fences stale generations', () => {
    store.createConnection(CONN_A);
    expect(store.getObservation('conn-a')).toBeNull();
    store.observe({
      connectionId: 'conn-a', generation: 1, observedBotUserId: 'bot-aaaa',
      state: 'connected', observedAt: 6_000,
    });
    store.observe({
      connectionId: 'conn-a', generation: 0, observedBotUserId: 'bot-evil',
      state: 'error', errorCode: 'generation_stale', observedAt: 6_100,
    });
    const observed = store.getObservation('conn-a')!;
    expect(observed.state).toBe('connected');
    expect(observed.observedBotUserId).toBe('bot-aaaa');
    expect(store.getConnection('conn-a')!.enabled).toBe(true);
  });

  it('upgrade: a pre-existing core database gains the tables without losing old data', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'duya-pc-legacy-'));
    const legacyDb = new Database(join(legacyDir, 'core.db'));
    try {
      legacyDb.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO meta (key, value) VALUES ('schema_version', '68');`);
      for (const migration of PROJECT_CHANNEL_MIGRATIONS) migration.up(legacyDb);
      expect(legacyDb.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: '68' });
      const upgraded = new ProjectChannelStore(legacyDb);
      expect(upgraded.createConnection(CONN_A).record.connectionId).toBe('conn-a');
      // Re-running the migration is a no-op: tables and rows survive.
      for (const migration of PROJECT_CHANNEL_MIGRATIONS) migration.up(legacyDb);
      expect(upgraded.getConnection('conn-a')!.botUserId).toBe('bot-aaaa');
    } finally {
      legacyDb.close();
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it('rollback: a fresh migration chain can be torn down and re-applied cleanly', () => {
    const names = PROJECT_CHANNEL_MIGRATIONS.map((m) => m.name);
    expect(names).toContain('create_project_channels');
    expect(PROJECT_CHANNEL_MIGRATIONS.every((m) => m.id === 69)).toBe(true);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'project_channel_%'",
    ).all() as { name: string }[];
    expect(tables.map((t) => t.name).sort()).toEqual([
      'project_channel_bindings',
      'project_channel_connections',
      'project_channel_deliveries',
      'project_channel_inbounds',
      'project_channel_observations',
    ]);
    for (const table of tables) db.exec(`DROP TABLE ${table.name}`);
    for (const migration of PROJECT_CHANNEL_MIGRATIONS) migration.up(db);
    expect(store.createConnection(CONN_A).record.connectionId).toBe('conn-a');
  });
});
