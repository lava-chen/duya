/**
 * Plan 621 slice B — `integrations` / `integration_sessions` (migration 43).
 *
 * These tests pin the projection contract only: the migration is registered
 * once and is re-runnable, observations overwrite each other without rewriting
 * `created_at`, a failed observation must carry its reason, and the session
 * association is idempotent with a `first_seen_at` that never moves.
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
