/**
 * Plan 621 slice B — `integrations` / `integration_sessions` (migration 43).
 * Plan 621 slice E — `integration_events` (migration 44).
 *
 * These tests pin the projection contract only: the migrations are registered
 * once and are re-runnable, observations overwrite each other without rewriting
 * `created_at`, a failed observation must carry its reason, the session
 * association is idempotent with a `first_seen_at` that never moves, and the
 * event history appends one row per OBSERVED STATE CHANGE — never per poll.
 *
 * Nothing here proves that GitHub was read or that a checkout may be reclaimed:
 * the table is a cache of an external fact, and §4.3 forbids either inference.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoreDataHost, collectCoreDatabaseMigrations } from '../src/core-data-host.js';
import { IntegrationStore } from '../src/integration-store.js';

const temporaryDirectories: string[] = [];
const openHosts: CoreDataHost[] = [];

afterEach(() => {
  for (const host of openHosts.splice(0)) host.close();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-integration-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function createHost(root: string): CoreDataHost {
  const host = new CoreDataHost({
    filename: path.join(root, 'duya-core.db'),
    rolloutRoot: path.join(root, 'sessions'),
    attachmentsRoot: path.join(root, 'attachments'),
    messageLogPorts: {
      botSessionIdPrefix: 'bot:',
      parseBotSessionId: () => null,
      getBotSessionLogPath: (agentId, dataRoot) => path.join(dataRoot, 'agents', agentId, 'sessions.jsonl'),
      getBotSessionsDir: (agentId, dataRoot) => path.join(dataRoot, 'agents', agentId, 'sessions'),
    },
  });
  openHosts.push(host);
  return host;
}

function tableColumns(host: CoreDataHost, table: string): string[] {
  return (
    host.database.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((column) => column.name);
}

describe('IntegrationStore — migration 43', () => {
  it('claims core migration id 43 exactly once, with no aggregate collision', () => {
    const migrations = collectCoreDatabaseMigrations();
    const ids = migrations.map((migration) => migration.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);

    const ours = migrations.filter((migration) => migration.id === 43);
    expect(ours.map((migration) => migration.name)).toEqual(['create_integrations']);
  });

  it('creates both tables in a fresh database and survives a reopen', () => {
    const root = makeTempDirectory();
    const first = createHost(root);
    expect(tableColumns(first, 'integrations')).toEqual([
      'repo',
      'pr_number',
      'observed_state',
      'observed_head_sha',
      'observed_base_ref',
      'observed_url',
      'observed_error',
      'observed_at',
      'created_at',
      'updated_at',
    ]);
    expect(tableColumns(first, 'integration_sessions')).toEqual([
      'repo',
      'pr_number',
      'session_id',
      'first_seen_at',
      'last_seen_at',
    ]);

    first.stores.integrations.upsertObservation({
      repo: 'duya/duya',
      prNumber: 7,
      state: 'open',
      observedAt: 1000,
    });
    first.close();

    // Second open runs the migration chain over an existing database: the
    // runner's `id <= current` guard skips 43 and the row is still there.
    const reopened = createHost(root);
    expect(reopened.stores.integrations.get('duya/duya', 7)?.observed_state).toBe('open');
    expect(reopened.stores.integrations.get('duya/duya', 7)?.observed_at).toBe(1000);
  });

  it('is idempotent when the DDL is re-run over a populated database', () => {
    const host = createHost(makeTempDirectory());
    host.stores.integrations.linkSession({ repo: 'duya/duya', prNumber: 7, sessionId: 's-1' });

    const migration = IntegrationStore.migrations[0]!;
    expect(() => migration.up(host.database.db)).not.toThrow();
    expect(host.stores.integrations.listSessionsFor('duya/duya', 7).map((row) => row.session_id)).toEqual(['s-1']);
  });

  it('does not reference the sessions table, so a legacy import cannot cascade the link away', () => {
    const host = createHost(makeTempDirectory());
    const foreignKeys = host.database.db
      .prepare('PRAGMA foreign_key_list(integration_sessions)')
      .all() as Array<{ table: string }>;
    expect(foreignKeys).toEqual([]);
  });
});

describe('IntegrationStore — migration 44 (integration_events)', () => {
  it('claims core migration id 44 exactly once, with no aggregate collision', () => {
    const migrations = collectCoreDatabaseMigrations();
    const ids = migrations.map((migration) => migration.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);

    const ours = migrations.filter((migration) => migration.id === 44);
    expect(ours.map((migration) => migration.name)).toEqual(['create_integration_events']);
  });

  it('creates the events table in a fresh database and survives a reopen', () => {
    const root = makeTempDirectory();
    const first = createHost(root);
    expect(tableColumns(first, 'integration_events')).toEqual([
      'id',
      'repo',
      'pr_number',
      'from_state',
      'to_state',
      'observed_error',
      'observed_at',
    ]);
    first.stores.integrations.upsertObservation({
      repo: 'duya/duya',
      prNumber: 7,
      state: 'open',
      observedAt: 1000,
    });
    first.close();

    const reopened = createHost(root);
    expect(reopened.stores.integrations.listEvents('duya/duya', 7).map((event) => event.to_state)).toEqual([
      'open',
    ]);
  });

  it('is idempotent when the migration 44 DDL is re-run over a populated database', () => {
    const host = createHost(makeTempDirectory());
    host.stores.integrations.upsertObservation({
      repo: 'duya/duya',
      prNumber: 7,
      state: 'open',
      observedAt: 1000,
    });

    const migration = IntegrationStore.migrations[1]!;
    expect(migration.id).toBe(44);
    expect(() => migration.up(host.database.db)).not.toThrow();
    expect(host.stores.integrations.listEvents('duya/duya', 7)).toHaveLength(1);
  });

  it('does not reference the integrations table, so the history outlives any rebuild of the projection', () => {
    const host = createHost(makeTempDirectory());
    const foreignKeys = host.database.db
      .prepare('PRAGMA foreign_key_list(integration_events)')
      .all() as Array<{ table: string }>;
    expect(foreignKeys).toEqual([]);
  });
});

describe('IntegrationStore — transition history', () => {
  it('appends one event per state change, with from_state NULL on the first', () => {
    const host = createHost(makeTempDirectory());
    const store = host.stores.integrations;

    // A→B→A must produce exactly three events: NULL→A, A→B, B→A. Returning to
    // a previously seen state is still a transition — the history is what
    // happened, not a set of states.
    store.upsertObservation({ repo: 'duya/duya', prNumber: 4, state: 'open', observedAt: 100 });
    store.upsertObservation({ repo: 'duya/duya', prNumber: 4, state: 'merged', observedAt: 200 });
    store.upsertObservation({ repo: 'duya/duya', prNumber: 4, state: 'open', observedAt: 300 });

    expect(store.listEvents('duya/duya', 4).map((event) => [event.from_state, event.to_state])).toEqual([
      ['merged', 'open'],
      ['open', 'merged'],
      [null, 'open'],
    ]);
  });

  it('does not append an event when the same state is observed again', () => {
    const host = createHost(makeTempDirectory());
    const store = host.stores.integrations;

    // A poller re-observing the same state must not flood the history: the
    // projection row's `observed_at` moves, the event list does not grow.
    for (const observedAt of [100, 200, 300]) {
      store.upsertObservation({ repo: 'duya/duya', prNumber: 4, state: 'open', observedAt });
    }
    expect(store.get('duya/duya', 4)?.observed_at).toBe(300);
    expect(store.listEvents('duya/duya', 4)).toHaveLength(1);
  });

  it('records a failed observation as an event with its reason', () => {
    const host = createHost(makeTempDirectory());
    const store = host.stores.integrations;

    store.upsertObservation({ repo: 'duya/duya', prNumber: 4, state: 'open', observedAt: 100 });
    store.upsertObservation({
      repo: 'duya/duya',
      prNumber: 4,
      state: 'unknown',
      observedError: 'gh_rate_limited',
      observedAt: 200,
    });

    const [latest] = store.listEvents('duya/duya', 4);
    expect(latest?.from_state).toBe('open');
    expect(latest?.to_state).toBe('unknown');
    expect(latest?.observed_error).toBe('gh_rate_limited');
    expect(latest?.observed_at).toBe(200);

    // A repeated failure stays one event: same state, no new history.
    store.upsertObservation({
      repo: 'duya/duya',
      prNumber: 4,
      state: 'unknown',
      observedError: 'gh_timeout',
      observedAt: 300,
    });
    expect(store.listEvents('duya/duya', 4)).toHaveLength(2);
  });

  it('keeps events per (repo, pr_number) and lists them newest first with a limit', () => {
    const host = createHost(makeTempDirectory());
    const store = host.stores.integrations;

    store.upsertObservation({ repo: 'duya/duya', prNumber: 1, state: 'open', observedAt: 100 });
    store.upsertObservation({ repo: 'duya/duya', prNumber: 1, state: 'merged', observedAt: 200 });
    store.upsertObservation({ repo: 'duya/duya', prNumber: 1, state: 'closed_unmerged', observedAt: 300 });
    store.upsertObservation({ repo: 'duya/duya', prNumber: 2, state: 'open', observedAt: 400 });
    store.upsertObservation({ repo: 'other/repo', prNumber: 1, state: 'open', observedAt: 500 });

    const all = store.listEvents('duya/duya', 1);
    expect(all.map((event) => event.to_state)).toEqual(['closed_unmerged', 'merged', 'open']);
    expect(store.listEvents('duya/duya', 1, 2).map((event) => event.to_state)).toEqual([
      'closed_unmerged',
      'merged',
    ]);
    expect(store.listEvents('duya/duya', 999)).toEqual([]);
    expect(store.listEvents('', 1)).toEqual([]);
  });
});

describe('IntegrationStore — observations', () => {
  it('overwrites observed_* on the next observation but keeps created_at', () => {
    const host = createHost(makeTempDirectory());
    const store = host.stores.integrations;

    const first = store.upsertObservation({
      repo: 'duya/duya',
      prNumber: 12,
      state: 'checks_failing',
      headSha: 'a'.repeat(40),
      baseRef: 'master',
      url: 'https://example.test/pr/12',
      observedAt: 1_000,
    });
    const second = store.upsertObservation({
      repo: 'duya/duya',
      prNumber: 12,
      state: 'merged',
      headSha: 'b'.repeat(40),
      baseRef: 'master',
      url: 'https://example.test/pr/12',
      observedAt: 2_000,
    });

    expect(second.observed_state).toBe('merged');
    expect(second.observed_head_sha).toBe('b'.repeat(40));
    expect(second.observed_at).toBe(2_000);
    expect(second.created_at).toBe(first.created_at);
    expect(store.get('duya/duya', 12)?.observed_at).toBe(2_000);
  });

  it('requires a reason for an unknown observation and clears it on success', () => {
    const host = createHost(makeTempDirectory());
    const store = host.stores.integrations;

    expect(() =>
      store.upsertObservation({ repo: 'duya/duya', prNumber: 3, state: 'unknown' }),
    ).toThrow(/observedError/);
    expect(store.get('duya/duya', 3)).toBeNull();

    const failed = store.upsertObservation({
      repo: 'duya/duya',
      prNumber: 3,
      state: 'unknown',
      observedError: 'gh_missing',
      observedAt: 10,
    });
    expect(failed.observed_state).toBe('unknown');
    expect(failed.observed_error).toBe('gh_missing');

    const recovered = store.upsertObservation({
      repo: 'duya/duya',
      prNumber: 3,
      state: 'open',
      observedAt: 20,
    });
    expect(recovered.observed_error).toBeNull();
  });

  it('rejects an empty repo or a non-positive PR number', () => {
    const host = createHost(makeTempDirectory());
    const store = host.stores.integrations;
    expect(() => store.upsertObservation({ repo: ' ', prNumber: 1, state: 'open' })).toThrow(/repo/);
    expect(() => store.upsertObservation({ repo: 'duya/duya', prNumber: 0, state: 'open' })).toThrow(/prNumber/);
    expect(() => store.linkSession({ repo: 'duya/duya', prNumber: 1, sessionId: '' })).toThrow(/sessionId/);
  });

  it('returns null for a PR that was never observed', () => {
    const host = createHost(makeTempDirectory());
    expect(host.stores.integrations.get('duya/duya', 999)).toBeNull();
  });
});

describe('IntegrationStore — session association', () => {
  it('is idempotent: a repeat link keeps first_seen_at and advances last_seen_at', () => {
    const host = createHost(makeTempDirectory());
    const store = host.stores.integrations;

    const first = store.linkSession({ repo: 'duya/duya', prNumber: 5, sessionId: 's-1', at: 1_000 });
    const second = store.linkSession({ repo: 'duya/duya', prNumber: 5, sessionId: 's-1', at: 5_000 });
    expect(second.first_seen_at).toBe(first.first_seen_at);
    expect(second.last_seen_at).toBe(5_000);
    expect(store.listSessionsFor('duya/duya', 5)).toHaveLength(1);

    // An older timestamp from a retried caller must not rewind recency.
    const stale = store.linkSession({ repo: 'duya/duya', prNumber: 5, sessionId: 's-1', at: 2_000 });
    expect(stale.last_seen_at).toBe(5_000);
    expect(stale.first_seen_at).toBe(1_000);
  });

  it('lists every PR of one session and nothing else', () => {
    const host = createHost(makeTempDirectory());
    const store = host.stores.integrations;

    store.upsertObservation({ repo: 'duya/duya', prNumber: 1, state: 'open', observedAt: 10 });
    store.upsertObservation({ repo: 'duya/duya', prNumber: 2, state: 'merged', observedAt: 20 });
    store.upsertObservation({ repo: 'other/repo', prNumber: 3, state: 'draft', observedAt: 30 });

    store.linkSession({ repo: 'duya/duya', prNumber: 1, sessionId: 's-1' });
    store.linkSession({ repo: 'duya/duya', prNumber: 2, sessionId: 's-1' });
    store.linkSession({ repo: 'other/repo', prNumber: 3, sessionId: 's-2' });

    expect(store.listForSession('s-1').map((row) => [row.repo, row.pr_number, row.observed_state])).toEqual([
      ['duya/duya', 1, 'open'],
      ['duya/duya', 2, 'merged'],
    ]);
    expect(store.listForSession('s-2').map((row) => row.pr_number)).toEqual([3]);
    expect(store.listForSession('s-unknown')).toEqual([]);
    expect(store.listForSession('')).toEqual([]);
  });

  it('keeps the association even when no observation exists yet', () => {
    const host = createHost(makeTempDirectory());
    const store = host.stores.integrations;
    store.linkSession({ repo: 'duya/duya', prNumber: 9, sessionId: 's-1' });

    expect(store.listSessionsFor('duya/duya', 9).map((row) => row.session_id)).toEqual(['s-1']);
    // Nothing to project until something was observed — an association is not
    // an observation, and inventing a row here would be a fabricated PR state.
    expect(store.listForSession('s-1')).toEqual([]);
  });
});
