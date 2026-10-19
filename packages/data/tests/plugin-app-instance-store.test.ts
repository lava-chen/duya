/**
 * T31b — Plugin App instance store (plan 610 batch 2, dispatch doc 23).
 *
 * These tests pin the persistence contract only: durable identity, isolated
 * per-app state, optimistic-concurrency writes, schema-version fencing, and
 * status transitions. They deliberately prove nothing about an iframe or a
 * production App MCP call — those need the Host-side acceptance in the plan.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoreDataHost, collectCoreDatabaseMigrations } from '../src/core-data-host.js';
import {
  PLUGIN_APP_INSTANCE_STATE_MAX_BYTES,
  PluginAppInstanceStoreError,
  type PluginAppInstanceRecord,
  type PluginAppInstanceState,
} from '../src/plugin-app-instance-store.js';

const temporaryDirectories: string[] = [];
const openHosts: CoreDataHost[] = [];

afterEach(() => {
  for (const host of openHosts.splice(0)) {
    host.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-app-instance-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

/** A second handle on the same file — the real cross-connection CAS contender. */
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

/**
 * Negative-path values are deliberately outside the accepted state type; the
 * store validates at runtime and must reject them instead of coercing.
 */
function state(value: unknown): PluginAppInstanceState {
  return value as PluginAppInstanceState;
}

function expectStoreError(action: () => unknown, reason: PluginAppInstanceStoreError['reason']): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PluginAppInstanceStoreError);
  expect((caught as PluginAppInstanceStoreError).reason).toBe(reason);
}

function createInstance(
  host: CoreDataHost,
  overrides: {
    instanceId?: string;
    pluginId?: string;
    appId?: string;
    stateSchemaVersion?: number;
  } = {},
): PluginAppInstanceRecord {
  return host.stores.appInstances.create({
    instanceId: overrides.instanceId ?? 'inst-1',
    pluginId: overrides.pluginId ?? 'plugin.alpha',
    appId: overrides.appId ?? 'app.one',
    stateSchemaVersion: overrides.stateSchemaVersion ?? 1,
    state: { view: 'initial' },
  });
}

describe('PluginAppInstanceStore — durable identity', () => {
  it('starts at revision 1 with an opaque JSON state and survives close/reopen', () => {
    const root = makeTempDirectory();
    const first = createHost(root);

    const created = createInstance(first, { stateSchemaVersion: 3 });
    expect(created.revision).toBe(1);
    expect(created.status).toBe('active');
    expect(created.state).toEqual({ view: 'initial' });
    expect(created.createdAt).toBe(created.updatedAt);
    expect(created.pluginId).toBe('plugin.alpha');
    expect(created.appId).toBe('app.one');
    expect(created.stateSchemaVersion).toBe(3);

    const written = first.stores.appInstances.writeState({
      instanceId: 'inst-1',
      state: { view: 'after-write', nested: { list: [1, 2, 3], flag: false, nothing: null } },
      expectedRevision: 1,
      expectedSchemaVersion: 3,
    });
    expect(written.ok).toBe(true);
    if (written.ok) expect(written.instance.revision).toBe(2);

    first.close();

    const reopened = createHost(root);
    const restored = reopened.stores.appInstances.get('inst-1');
    expect(restored).not.toBeNull();
    expect(restored?.revision).toBe(2);
    expect(restored?.stateSchemaVersion).toBe(3);
    expect(restored?.status).toBe('active');
    expect(restored?.state).toEqual({
      view: 'after-write',
      nested: { list: [1, 2, 3], flag: false, nothing: null },
    });
    expect(restored?.createdAt).toBe(created.createdAt);
  });

  it('persists a disabled instance across reopen and keeps its revision', () => {
    const root = makeTempDirectory();
    const first = createHost(root);
    createInstance(first);
    const disabled = first.stores.appInstances.setStatus({
      instanceId: 'inst-1',
      status: 'disabled',
      expectedRevision: 1,
    });
    expect(disabled.ok).toBe(true);
    if (disabled.ok) {
      expect(disabled.instance.status).toBe('disabled');
      expect(disabled.instance.revision).toBe(2);
    }
    first.close();

    const reopened = createHost(root);
    expect(reopened.stores.appInstances.get('inst-1')?.status).toBe('disabled');
  });

  it('keeps two apps and two instances of one app isolated', () => {
    const host = createHost(makeTempDirectory());
    const store = host.stores.appInstances;

    createInstance(host, { instanceId: 'a-one-i1', appId: 'app.one' });
    createInstance(host, { instanceId: 'a-one-i2', appId: 'app.one' });
    createInstance(host, { instanceId: 'a-two-i1', appId: 'app.two' });
    createInstance(host, { instanceId: 'other-i1', appId: 'app.one', pluginId: 'plugin.beta' });

    for (const [index, instanceId] of ['a-one-i1', 'a-one-i2', 'a-two-i1'].entries()) {
      const result = store.writeState({
        instanceId,
        state: { owner: instanceId, seq: index },
        expectedRevision: 1,
        expectedSchemaVersion: 1,
      });
      expect(result.ok).toBe(true);
    }

    expect(store.listByPlugin('plugin.alpha').map((row) => row.instanceId)).toEqual([
      'a-one-i1',
      'a-one-i2',
      'a-two-i1',
    ]);
    expect(store.listByApp('plugin.alpha', 'app.one').map((row) => row.instanceId)).toEqual([
      'a-one-i1',
      'a-one-i2',
    ]);
    expect(store.listByApp('plugin.alpha', 'app.two').map((row) => row.instanceId)).toEqual(['a-two-i1']);
    expect(store.listByPlugin('plugin.beta').map((row) => row.instanceId)).toEqual(['other-i1']);

    expect(store.get('a-one-i1')?.state).toEqual({ owner: 'a-one-i1', seq: 0 });
    expect(store.get('a-one-i2')?.state).toEqual({ owner: 'a-one-i2', seq: 1 });
    expect(store.get('a-two-i1')?.state).toEqual({ owner: 'a-two-i1', seq: 2 });
    expect(store.get('other-i1')?.state).toEqual({ view: 'initial' });
    expect(store.get('a-one-i1')?.revision).toBe(2);
    expect(store.get('a-one-i2')?.revision).toBe(2);
    expect(store.get('other-i1')?.revision).toBe(1);
  });

  it('never stores session, run, nonce, grant, or credential columns', () => {
    const host = createHost(makeTempDirectory());
    createInstance(host);
    const columns = (
      host.database.db.prepare('PRAGMA table_info(plugin_app_instances)').all() as Array<{ name: string }>
    ).map((column) => column.name);

    expect(columns).toEqual([
      'instance_id',
      'plugin_id',
      'app_id',
      'state_schema_version',
      'state_json',
      'revision',
      'status',
      'created_at',
      'updated_at',
    ]);
    for (const column of columns) {
      expect(column).not.toMatch(/session|run_id|nonce|grant|credential|token|secret|scope|auth/i);
    }
  });
});

describe('PluginAppInstanceStore — migration registration', () => {
  it('claims core migration id 40 exactly once, with no aggregate collision', () => {
    const migrations = collectCoreDatabaseMigrations();
    const ids = migrations.map((migration) => migration.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);

    const ours = migrations.filter((migration) => migration.id === 40);
    expect(ours.map((migration) => migration.name)).toEqual(['create_plugin_app_instances']);
  });
});

describe('PluginAppInstanceStore — compare-and-set writes', () => {
  it('lets the winner commit and makes a stale writer lose without overwriting it', () => {
    const root = makeTempDirectory();
    const writer = createHost(root);
    const rival = createHost(root);
    createInstance(writer);

    // Both connections observed revision 1 before either wrote.
    expect(writer.stores.appInstances.get('inst-1')?.revision).toBe(1);
    expect(rival.stores.appInstances.get('inst-1')?.revision).toBe(1);

    const winner = rival.stores.appInstances.writeState({
      instanceId: 'inst-1',
      state: { winner: true },
      expectedRevision: 1,
      expectedSchemaVersion: 1,
    });
    expect(winner.ok).toBe(true);

    const loser = writer.stores.appInstances.writeState({
      instanceId: 'inst-1',
      state: { loser: true },
      expectedRevision: 1,
      expectedSchemaVersion: 1,
    });
    expect(loser.ok).toBe(false);
    if (!loser.ok) {
      expect(loser.reason).toBe('stale_revision');
      expect(loser.instance?.revision).toBe(2);
    }

    const stored = writer.stores.appInstances.get('inst-1');
    expect(stored?.state).toEqual({ winner: true });
    expect(stored?.revision).toBe(2);
  });

  it('reports not_found for an unknown instance instead of creating one', () => {
    const host = createHost(makeTempDirectory());
    const store = host.stores.appInstances;

    const write = store.writeState({
      instanceId: 'missing',
      state: { nope: true },
      expectedRevision: 1,
      expectedSchemaVersion: 1,
    });
    expect(write).toEqual({ ok: false, reason: 'not_found', instance: null });

    const status = store.setStatus({ instanceId: 'missing', status: 'disabled', expectedRevision: 1 });
    expect(status).toEqual({ ok: false, reason: 'not_found', instance: null });

    expect(store.listByPlugin('plugin.alpha')).toEqual([]);
  });

  it('leaves payload and revision untouched when the schema version does not match', () => {
    const host = createHost(makeTempDirectory());
    createInstance(host, { stateSchemaVersion: 2 });

    const result = host.stores.appInstances.writeState({
      instanceId: 'inst-1',
      state: { view: 'written-with-wrong-version' },
      expectedRevision: 1,
      expectedSchemaVersion: 3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('schema_mismatch');
      expect(result.instance?.stateSchemaVersion).toBe(2);
    }

    const stored = host.stores.appInstances.get('inst-1');
    expect(stored?.state).toEqual({ view: 'initial' });
    expect(stored?.revision).toBe(1);
    expect(stored?.updatedAt).toBe(stored?.createdAt);

    // The caller can still commit against the version actually stored.
    const correct = host.stores.appInstances.writeState({
      instanceId: 'inst-1',
      state: { view: 'written-with-right-version' },
      expectedRevision: 1,
      expectedSchemaVersion: 2,
    });
    expect(correct.ok).toBe(true);
  });
});

describe('PluginAppInstanceStore — status transitions', () => {
  it('rejects state writes while disabled and allows an explicit reactivation', () => {
    const host = createHost(makeTempDirectory());
    const store = host.stores.appInstances;
    createInstance(host);

    const disabled = store.setStatus({ instanceId: 'inst-1', status: 'disabled', expectedRevision: 1 });
    expect(disabled.ok).toBe(true);
    if (disabled.ok) expect(disabled.instance.revision).toBe(2);

    const blocked = store.writeState({
      instanceId: 'inst-1',
      state: { view: 'while-disabled' },
      expectedRevision: 2,
      expectedSchemaVersion: 1,
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.reason).toBe('inactive');
      expect(blocked.instance?.status).toBe('disabled');
    }
    expect(store.get('inst-1')?.state).toEqual({ view: 'initial' });
    expect(store.get('inst-1')?.revision).toBe(2);

    const reactivated = store.setStatus({ instanceId: 'inst-1', status: 'active', expectedRevision: 2 });
    expect(reactivated.ok).toBe(true);
    if (reactivated.ok) expect(reactivated.instance.revision).toBe(3);

    const accepted = store.writeState({
      instanceId: 'inst-1',
      state: { view: 'after-reactivation' },
      expectedRevision: 3,
      expectedSchemaVersion: 1,
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.instance.revision).toBe(4);
    expect(store.get('inst-1')?.state).toEqual({ view: 'after-reactivation' });
  });

  it('makes revoked terminal for both writes and reactivation', () => {
    const host = createHost(makeTempDirectory());
    const store = host.stores.appInstances;
    createInstance(host);
    store.writeState({
      instanceId: 'inst-1',
      state: { view: 'live' },
      expectedRevision: 1,
      expectedSchemaVersion: 1,
    });

    const revoked = store.setStatus({ instanceId: 'inst-1', status: 'revoked', expectedRevision: 2 });
    expect(revoked.ok).toBe(true);
    if (revoked.ok) {
      expect(revoked.instance.status).toBe('revoked');
      expect(revoked.instance.revision).toBe(3);
    }

    for (const status of ['active', 'disabled'] as const) {
      const reactivation = store.setStatus({ instanceId: 'inst-1', status, expectedRevision: 3 });
      expect(reactivation.ok).toBe(false);
      if (!reactivation.ok) {
        expect(reactivation.reason).toBe('invalid_transition');
        expect(reactivation.instance?.status).toBe('revoked');
      }
    }

    const blockedWrite = store.writeState({
      instanceId: 'inst-1',
      state: { view: 'after-revoke' },
      expectedRevision: 3,
      expectedSchemaVersion: 1,
    });
    expect(blockedWrite.ok).toBe(false);
    if (!blockedWrite.ok) expect(blockedWrite.reason).toBe('inactive');

    expect(store.get('inst-1')?.status).toBe('revoked');
    expect(store.get('inst-1')?.revision).toBe(3);
    expect(store.get('inst-1')?.state).toEqual({ view: 'live' });
  });

  it('cas-checks a status change against the held revision', () => {
    const host = createHost(makeTempDirectory());
    // A freshly created instance sits at revision 1; a caller holding a
    // different revision must lose the compare-and-set.
    createInstance(host);
    expect(host.stores.appInstances.get('inst-1')?.revision).toBe(1);

    const stale = host.stores.appInstances.setStatus({
      instanceId: 'inst-1',
      status: 'disabled',
      expectedRevision: 99,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.reason).toBe('stale_revision');
      expect(stale.instance?.revision).toBe(1);
    }
    expect(host.stores.appInstances.get('inst-1')?.status).toBe('active');
    expect(host.stores.appInstances.get('inst-1')?.revision).toBe(1);
  });
});

describe('PluginAppInstanceStore — state validation', () => {
  it('rejects values that JSON would silently coerce', () => {
    const host = createHost(makeTempDirectory());
    createInstance(host);
    const store = host.stores.appInstances;

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    let getterCalls = 0;
    const accessorState: Record<string, unknown> = {};
    Object.defineProperty(accessorState, 'view', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'getter-value';
      },
    });
    const hiddenState: Record<string, unknown> = {};
    Object.defineProperty(hiddenState, 'hidden', { value: undefined, enumerable: false });
    const arrayWithExtraProperty: unknown[] & { extra?: unknown } = [1];
    Object.defineProperty(arrayWithExtraProperty, 'extra', { value: undefined, enumerable: true });
    const arrayWithSymbol = [1];
    Object.defineProperty(arrayWithSymbol, Symbol('extra'), { value: 'ignored' });
    const arrayWithHiddenIndex = [1];
    Object.defineProperty(arrayWithHiddenIndex, '0', { value: 1, enumerable: false });

    const cases: Array<[string, unknown]> = [
      ['undefined property', { view: undefined }],
      ['array hole', [1, , 3]],
      ['array undefined element', [1, undefined]],
      ['NaN', { value: Number.NaN }],
      ['Infinity', { value: Number.POSITIVE_INFINITY }],
      ['Date', { at: new Date(0) }],
      ['Map', { at: new Map([['k', 'v']]) }],
      ['Set', { at: new Set(['v']) }],
      ['function', { run: () => 'nope' }],
      ['symbol', { tag: Symbol('tag') }],
      ['bigint', { size: 10n }],
      ['class instance', { holder: new (class Holder {})() }],
      ['circular reference', circular],
      ['accessor property', accessorState],
      ['non-enumerable object property', hiddenState],
      ['array extra string property', { values: arrayWithExtraProperty }],
      ['array symbol property', { values: arrayWithSymbol }],
      ['non-enumerable array index', { values: arrayWithHiddenIndex }],
      ['array at top level', [1, 2, 3]],
      ['null at top level', null],
    ];

    for (const [label, value] of cases) {
      expectStoreError(
        () =>
          store.writeState({
            instanceId: 'inst-1',
            state: state(value),
            expectedRevision: 1,
            expectedSchemaVersion: 1,
          }),
        'invalid_state',
      );
      expect(store.get('inst-1')?.state, `${label} must not be persisted`).toEqual({ view: 'initial' });
      expect(store.get('inst-1')?.revision, `${label} must not bump revision`).toBe(1);
    }
    expect(getterCalls, 'accessor validation must not execute the getter').toBe(0);
  });

  it('rejects a state payload over 256 KiB and keeps a large payload under it', () => {
    const host = createHost(makeTempDirectory());
    createInstance(host);
    const store = host.stores.appInstances;

    expectStoreError(
      () =>
        store.writeState({
          instanceId: 'inst-1',
          state: { blob: 'x'.repeat(PLUGIN_APP_INSTANCE_STATE_MAX_BYTES) },
          expectedRevision: 1,
          expectedSchemaVersion: 1,
        }),
      'state_too_large',
    );
    expect(store.get('inst-1')?.revision).toBe(1);

    const accepted = store.writeState({
      instanceId: 'inst-1',
      state: { blob: 'x'.repeat(64 * 1024) },
      expectedRevision: 1,
      expectedSchemaVersion: 1,
    });
    expect(accepted.ok).toBe(true);
  });

  it('counts the limit in UTF-8 bytes, not code units', () => {
    const host = createHost(makeTempDirectory());
    createInstance(host);
    const store = host.stores.appInstances;

    // Each CJK code point is 3 UTF-8 bytes but one UTF-16 code unit.
    const cjkCount = Math.ceil(PLUGIN_APP_INSTANCE_STATE_MAX_BYTES / 3);
    expectStoreError(
      () =>
        store.writeState({
          instanceId: 'inst-1',
          state: { blob: '性'.repeat(cjkCount) },
          expectedRevision: 1,
          expectedSchemaVersion: 1,
        }),
      'state_too_large',
    );
    expect(store.get('inst-1')?.revision).toBe(1);
  });

  it('rejects invalid creation input and never reuses an instance id', () => {
    const host = createHost(makeTempDirectory());
    const store = host.stores.appInstances;
    createInstance(host);

    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY] as const) {
      expectStoreError(
        () =>
          store.create({
            instanceId: 'inst-invalid',
            pluginId: 'plugin.alpha',
            appId: 'app.one',
            stateSchemaVersion: invalid,
          }),
        'invalid_input',
      );
    }
    for (const invalid of ['', '   ']) {
      expectStoreError(
        () =>
          store.create({
            instanceId: invalid,
            pluginId: 'plugin.alpha',
            appId: 'app.one',
            stateSchemaVersion: 1,
          }),
        'invalid_input',
      );
      expectStoreError(
        () =>
          store.create({
            instanceId: 'inst-other',
            pluginId: invalid,
            appId: 'app.one',
            stateSchemaVersion: 1,
          }),
        'invalid_input',
      );
      expectStoreError(
        () =>
          store.create({
            instanceId: 'inst-other',
            pluginId: 'plugin.alpha',
            appId: invalid,
            stateSchemaVersion: 1,
          }),
        'invalid_input',
      );
    }

    expectStoreError(
      () =>
        store.create({
          instanceId: 'inst-1',
          pluginId: 'plugin.beta',
          appId: 'app.two',
          stateSchemaVersion: 1,
        }),
      'already_exists',
    );

    expect(store.listByPlugin('plugin.alpha').map((row) => row.instanceId)).toEqual(['inst-1']);
    expect(store.listByPlugin('plugin.beta')).toEqual([]);
    expect(store.get('inst-1')?.pluginId).toBe('plugin.alpha');
  });
});
