/**
 * telegram-offset.test.ts — offset persistence and startup backlog
 * capping for the Telegram connector (ISS-23).
 *
 * The offset used to be a plain field, so a restart replayed whatever
 * Telegram still had queued. fetch is injected, so no network is used; the
 * store is injected too, and the DB-backed factory is exercised against a
 * real in-memory SQLite table with the real channel_offsets schema.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

import {
  TelegramChannelConnector,
  createChannelOffsetStore,
  type TelegramOffsetStore,
} from '../telegram-connector';

const mocks = vi.hoisted(() => ({ userDataDir: '' }));

vi.mock('electron', () => ({
  app: { getPath: (_name: string) => mocks.userDataDir },
  screen: { screenToDipRect: (r: unknown) => r },
}));

import { ConfigStore } from '../../config/store';
import { _setConfigStoreForTest } from '../../config/store-instance';

const TOKEN = 'bot-token';
let tmpRoot: string;

/**
 * A faithful stand-in for the Telegram getUpdates queue: it serves only
 * updates at or after the requested offset, consumes what it returns, and
 * honours a per-poll page size. A stub that ignored the offset would
 * re-deliver the same batch forever and make every assertion meaningless.
 */
function telegramStub(ids: number[], maxPerPoll = 100) {
  const queue = [...ids].sort((a, b) => a - b);
  const calls: string[] = [];
  const fn = (async (url: string) => {
    const href = String(url);
    calls.push(href);
    const m = /offset=(\d+)/.exec(href);
    const offset = m ? Number(m[1]) : 0;
    const eligible = queue.filter((id) => id >= offset);
    const take = eligible.slice(0, maxPerPoll);
    for (const id of take) {
      const i = queue.indexOf(id);
      if (i >= 0) queue.splice(i, 1);
    }
    return new Response(
      JSON.stringify({ ok: true, result: take.map((id) => update(id, `m${id}`)) }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { fn, calls, remaining: () => queue.length };
}

function memoryStore(initial: number | null = null) {
  const saved: number[] = [];
  const store: TelegramOffsetStore = {
    load: () => initial,
    save: (o: number) => {
      saved.push(o);
    },
  };
  return { store, saved };
}

function update(id: number, text: string) {
  return { update_id: id, message: { message_id: id, chat: { id: 1, type: 'private' }, text } };
}

function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

beforeEach(() => {
  tmpRoot = `${process.env.TEMP ?? '.'}\\duya-tg-offset-${Math.random().toString(36).slice(2)}`;
  mocks.userDataDir = tmpRoot;
  _setConfigStoreForTest(
    new ConfigStore({
      configPath: `${tmpRoot}\\config.toml`,
      secretsPath: `${tmpRoot}\\secrets.json`,
    }),
  );
});

afterEach(() => {
  _setConfigStoreForTest(undefined);
  vi.restoreAllMocks();
});

describe('offset persistence (ISS-23)', () => {
  it('restores the stored offset and asks Telegram to start from there', async () => {
    const onInbound = vi.fn();
    const { fn, calls } = telegramStub([500]);
    const { store } = memoryStore(417);

    const connector = new TelegramChannelConnector({
      agentId: 'bot-a', token: TOKEN, onInbound, fetchFn: fn, offsetStore: store,
    });
    connector.start();
    await waitFor(() => onInbound.mock.calls.length > 0);
    await connector.stop();

    expect(calls[0]).toContain('offset=417');
  });

  it('persists the offset after a batch is handled', async () => {
    const onInbound = vi.fn();
    const { fn } = telegramStub([10, 11]);
    const { store, saved } = memoryStore(null);

    const connector = new TelegramChannelConnector({
      agentId: 'bot-a', token: TOKEN, onInbound, fetchFn: fn, offsetStore: store,
    });
    connector.start();
    await waitFor(() => onInbound.mock.calls.length >= 2);
    await connector.stop();

    // offset = last update_id + 1
    expect(saved[saved.length - 1]).toBe(12);
  });

  it('starts from 0 when nothing is stored', async () => {
    const onInbound = vi.fn();
    const { fn, calls } = telegramStub([]);
    const { store } = memoryStore(null);

    const connector = new TelegramChannelConnector({
      agentId: 'bot-a', token: TOKEN, onInbound, fetchFn: fn, offsetStore: store,
    });
    connector.start();
    await waitFor(() => calls.length > 0);
    await connector.stop();

    expect(calls[0]).toContain('offset=0');
  });

  it('ignores a stored value that is not a usable offset', async () => {
    const onInbound = vi.fn();
    for (const bad of [-5, Number.NaN, 1.5]) {
      const { fn, calls } = telegramStub([]);
      const connector = new TelegramChannelConnector({
        agentId: 'bot-a', token: TOKEN, onInbound, fetchFn: fn, offsetStore: memoryStore(bad).store,
      });
      connector.start();
      await waitFor(() => calls.length > 0);
      await connector.stop();
      expect(calls[0]).toContain('offset=0');
    }
  });

  it('keeps polling when the store throws, rather than dying', async () => {
    const onInbound = vi.fn();
    const { fn, calls } = telegramStub([1]);
    const store: TelegramOffsetStore = {
      load: () => { throw new Error('db gone'); },
      save: () => { throw new Error('db gone'); },
    };

    const connector = new TelegramChannelConnector({
      agentId: 'bot-a', token: TOKEN, onInbound, fetchFn: fn, offsetStore: store,
    });
    connector.start();
    await waitFor(() => onInbound.mock.calls.length > 0);
    await connector.stop();

    expect(calls.length).toBeGreaterThan(0);
    expect(onInbound).toHaveBeenCalled();
  });

  it('behaves exactly as before when no store is supplied', async () => {
    const onInbound = vi.fn();
    const { fn, calls } = telegramStub([9]);

    const connector = new TelegramChannelConnector({
      agentId: 'bot-a', token: TOKEN, onInbound, fetchFn: fn,
    });
    connector.start();
    await waitFor(() => onInbound.mock.calls.length > 0);
    await connector.stop();

    expect(calls[0]).toContain('offset=0');
  });
});

describe('startup backlog cap', () => {
  it('skips the excess of a large first batch and advances past it', async () => {
    const onInbound = vi.fn();
    const ids = Array.from({ length: 10 }, (_, i) => i);
    const { fn, calls } = telegramStub(ids);
    const { store, saved } = memoryStore(null);

    const connector = new TelegramChannelConnector({
      agentId: 'bot-a', token: TOKEN, onInbound, fetchFn: fn,
      offsetStore: store, startupBacklogLimit: 3,
    });
    connector.start();
    await waitFor(() => saved.length > 0);
    await connector.stop();

    // First batch delivered 3 of 10; the skipped ones are not replayed.
    expect(onInbound).toHaveBeenCalledTimes(3);
    // Offset moved to newest + 1 so Telegram does not serve them again.
    expect(saved[saved.length - 1]).toBe(10);
    expect(calls[1]).toContain('offset=10');
  });

  it('leaves a batch at the limit untouched', async () => {
    const onInbound = vi.fn();
    const { fn } = telegramStub([1, 2]);
    const { store } = memoryStore(null);

    const connector = new TelegramChannelConnector({
      agentId: 'bot-a', token: TOKEN, onInbound, fetchFn: fn,
      offsetStore: store, startupBacklogLimit: 2,
    });
    connector.start();
    await waitFor(() => onInbound.mock.calls.length >= 2);
    await connector.stop();

    expect(onInbound).toHaveBeenCalledTimes(2);
  });

  it('caps only the first batch, so a steady backlog still drains fully', async () => {
    const onInbound = vi.fn();
    // Telegram pages the queue, so the backlog arrives over several polls.
    // The first page is capped; every later one drains in full.
    const ids = Array.from({ length: 10 }, (_, i) => i + 1);
    const { fn } = telegramStub(ids, 5);
    const { store, saved } = memoryStore(null);

    const connector = new TelegramChannelConnector({
      agentId: 'bot-a', token: TOKEN, onInbound, fetchFn: fn,
      offsetStore: store, startupBacklogLimit: 3,
    });
    connector.start();
    await waitFor(() => onInbound.mock.calls.length >= 8);
    await connector.stop();

    // First page: 5 offered, 3 kept, 2 skipped (ids 4 and 5).
    // Second page: 5 more delivered in full — only the first page is capped.
    expect(onInbound).toHaveBeenCalledTimes(8);
    expect(saved[saved.length - 1]).toBe(11);
  });

  it('can be disabled with Infinity', async () => {
    const onInbound = vi.fn();
    const ids = Array.from({ length: 8 }, (_, i) => i);
    const { fn } = telegramStub(ids);
    const { store } = memoryStore(null);

    const connector = new TelegramChannelConnector({
      agentId: 'bot-a', token: TOKEN, onInbound, fetchFn: fn,
      offsetStore: store, startupBacklogLimit: Infinity,
    });
    connector.start();
    await waitFor(() => onInbound.mock.calls.length >= 8);
    await connector.stop();

    expect(onInbound).toHaveBeenCalledTimes(8);
  });
});

describe('createChannelOffsetStore against a real table', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE channel_offsets (
        channel_type TEXT NOT NULL,
        offset_key TEXT NOT NULL,
        offset_value TEXT NOT NULL,
        offset_type TEXT NOT NULL DEFAULT 'long_polling',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (channel_type, offset_key)
      )
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('round-trips an offset', () => {
    const store = createChannelOffsetStore(() => db, 'telegram', 'bot-a');
    expect(store.load()).toBeNull();
    store.save(4242);
    expect(store.load()).toBe(4242);
  });

  it('overwrites rather than duplicating on a second save', () => {
    const store = createChannelOffsetStore(() => db, 'telegram', 'bot-a');
    store.save(1);
    store.save(9);
    const rows = db
      .prepare('SELECT offset_value FROM channel_offsets WHERE channel_type = ? AND offset_key = ?')
      .all('telegram', 'bot-a');
    expect(rows).toHaveLength(1);
    expect(store.load()).toBe(9);
  });

  it('keeps agents isolated from each other', () => {
    const a = createChannelOffsetStore(() => db, 'telegram', 'bot-a');
    const b = createChannelOffsetStore(() => db, 'telegram', 'bot-b');
    a.save(100);
    b.save(200);
    expect(a.load()).toBe(100);
    expect(b.load()).toBe(200);
  });

  it('treats a corrupt stored value as absent', () => {
    db.prepare(
      'INSERT INTO channel_offsets (channel_type, offset_key, offset_value, offset_type, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('telegram', 'bot-a', 'not-a-number', 'long_polling', 1);
    const store = createChannelOffsetStore(() => db, 'telegram', 'bot-a');
    expect(store.load()).toBeNull();
  });

  it('degrades to no persistence when the database is unavailable', () => {
    const notes: string[] = [];
    const store = createChannelOffsetStore(
      () => null,
      'telegram',
      'bot-a',
      (reason) => notes.push(reason),
    );
    expect(() => store.save(1)).not.toThrow();
    expect(store.load()).toBeNull();
    expect(notes.join(' ')).toMatch(/database not available/);
  });

  it('survives a connector restart without replaying the batch', async () => {
    const onInbound = vi.fn();
    const first = telegramStub([50]);
    const store = createChannelOffsetStore(() => db, 'telegram', 'bot-a');

    const c1 = new TelegramChannelConnector({
      agentId: 'bot-a', token: TOKEN, onInbound, fetchFn: first.fn, offsetStore: store,
    });
    c1.start();
    await waitFor(() => onInbound.mock.calls.length > 0);
    await c1.stop();
    expect(store.load()).toBe(51);

    // Restart: the next poll must ask from 51, not 0.
    const onInbound2 = vi.fn();
    const second = telegramStub([]);
    const c2 = new TelegramChannelConnector({
      agentId: 'bot-a', token: TOKEN, onInbound: onInbound2, fetchFn: second.fn, offsetStore: store,
    });
    c2.start();
    await waitFor(() => second.calls.length > 0);
    await c2.stop();

    expect(second.calls[0]).toContain('offset=51');
  });
});
