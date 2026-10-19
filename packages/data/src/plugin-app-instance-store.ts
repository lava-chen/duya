/**
 * plugin-app-instance-store.ts — durable App instance identity for `duya-core.db`
 * (plan 610 T31b, dispatch doc 23).
 *
 * ## What this owns
 *
 * A Plugin App instance is the persistent half of a running App. This store is
 * its identity and its opaque JSON state, nothing else:
 *
 *   - `instance_id` — minted by the Host, stable for the lifetime of the App.
 *   - `plugin_id` / `app_id` — which declaration the instance was created from.
 *   - `state_schema_version` — the version of the state shape the App declared
 *     in its manifest. It is written once and never migrated here.
 *   - `state_json` — opaque to Data. Data never reads its meaning.
 *   - `revision` — starts at 1, incremented by every accepted write.
 *   - `status` — `active` / `disabled` / `revoked`.
 *
 * ## What this deliberately does NOT store
 *
 * No session id, no run id, no instance nonce, no capability grants, no MCP
 * credentials. Those are per-start authority: the next launch must rebuild the
 * binding from live Host and worker state, and a persisted row must never be
 * able to stand in for that. `PRAGMA table_info` is asserted in
 * `tests/plugin-app-instance-store.test.ts` so a future column cannot quietly
 * widen this boundary.
 *
 * This vocabulary is NOT the App Connection vocabulary (`app-connections`):
 * a Connection is a stored, user-visible external credential; an App instance
 * is an opaque blob of App-owned state that happens to be reachable through
 * one. The table is `plugin_app_instances` for that reason.
 *
 * ## Concurrency
 *
 * Writes are compare-and-set on `(instance_id, revision,
 * state_schema_version, status)`. A caller states the revision and the schema
 * version it believes it is writing against; anything else loses and is told
 * which expectation was wrong. Losing never overwrites the winner, and a
 * mismatch never resets, migrates, or silently re-versions the payload.
 *
 * The read and the write share one IMMEDIATE transaction, so the guarded
 * UPDATE below is a second assertion of the same condition rather than the
 * place the decision is made.
 *
 * ## Migration id 40
 *
 * Core migration ids run in one sequence across `collectCoreDataMigrations()`
 * (see `core-data-host.ts`); the highest core id in this package before this
 * file was 39 (`run-store.ts`). 40 was re-checked against the aggregate at
 * authoring time and was free. `main-schema.ts` numbers the SEPARATE main
 * database and reaches past 40; the two sequences are independent.
 *
 * `revision` starts at 1 because 1 is the first revision a row can hold, and
 * CAS callers compare against it before any write has happened.
 */

import { Buffer } from 'node:buffer';
import type { Migration, SqliteDatabase } from './core-database.js';
import type {
  PluginAppInstanceStatus, PluginAppInstanceStateValue, PluginAppInstanceState,
  PluginAppInstanceRecord, PluginAppInstanceWriteRejection, PluginAppInstanceWriteResult,
  PluginAppInstanceStatusRejection, PluginAppInstanceStatusResult,
} from '@duya/agent-protocol';
export type {
  PluginAppInstanceStatus, PluginAppInstanceStateValue, PluginAppInstanceState,
  PluginAppInstanceRecord, PluginAppInstanceWriteRejection, PluginAppInstanceWriteResult,
  PluginAppInstanceStatusRejection, PluginAppInstanceStatusResult,
} from '@duya/agent-protocol';

/** Hard ceiling on one serialized state payload, measured in UTF-8 bytes. */
export const PLUGIN_APP_INSTANCE_STATE_MAX_BYTES = 256 * 1024;

export interface CreatePluginAppInstanceInput {
  /** Host-minted. Reusing one is an `already_exists` error, never an upsert. */
  instanceId: string;
  pluginId: string;
  appId: string;
  stateSchemaVersion: number;
  state?: PluginAppInstanceState;
}

export interface WritePluginAppInstanceStateInput {
  instanceId: string;
  state: PluginAppInstanceState;
  expectedRevision: number;
  expectedSchemaVersion: number;
}

export interface SetPluginAppInstanceStatusInput {
  instanceId: string;
  status: PluginAppInstanceStatus;
  expectedRevision: number;
}

export type PluginAppInstanceStoreErrorReason =
  /** An id was blank or a version/revision was not a positive integer. */
  | 'invalid_input'
  /** Not strictly JSON — see {@link serializeState}. */
  | 'invalid_state'
  | 'state_too_large'
  /** The instance id is already taken by another row. */
  | 'already_exists'
  /** Persisted state is not readable as a JSON object. */
  | 'corrupt_state'
  /**
   * The guarded UPDATE changed no row although every precondition had passed
   * inside an IMMEDIATE transaction. That is an invariant violation, not a
   * caller-visible outcome, so it throws instead of being reported as a
   * concurrency rejection the caller would then retry forever.
   */
  | 'cas_mismatch';

/**
 * Thrown instead of persisting something that is not what the caller passed:
 * invalid input, state that is not strictly JSON, an oversized payload, a
 * taken instance id, an unreadable stored payload, or a broken CAS invariant.
 * Callers that can recover read `reason`; the four concurrent-write outcomes
 * (`not_found` / `stale_revision` / `schema_mismatch` / `inactive`) are
 * returned, never thrown, so a busy writer is not an error path.
 */
export class PluginAppInstanceStoreError extends Error {
  readonly reason: PluginAppInstanceStoreErrorReason;

  constructor(reason: PluginAppInstanceStoreErrorReason, message: string) {
    super(message);
    this.name = 'PluginAppInstanceStoreError';
    this.reason = reason;
  }
}

interface PluginAppInstanceRow {
  instance_id: string;
  plugin_id: string;
  app_id: string;
  state_schema_version: number;
  state_json: string;
  revision: number;
  status: string;
  created_at: number;
  updated_at: number;
}

export class PluginAppInstanceStore {
  /** Migration id=40: create plugin_app_instances. Additive, no FK. */
  static readonly migrations: Migration[] = [
    {
      id: 40,
      name: 'create_plugin_app_instances',
      up: (db) => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS plugin_app_instances (
            instance_id          TEXT PRIMARY KEY,
            plugin_id            TEXT NOT NULL,
            app_id               TEXT NOT NULL,
            state_schema_version INTEGER NOT NULL,
            state_json           TEXT NOT NULL,
            revision             INTEGER NOT NULL DEFAULT 1,
            status               TEXT NOT NULL DEFAULT 'active',
            created_at           INTEGER NOT NULL,
            updated_at           INTEGER NOT NULL,
            CHECK (length(trim(instance_id)) > 0),
            CHECK (length(trim(plugin_id)) > 0),
            CHECK (length(trim(app_id)) > 0),
            CHECK (state_schema_version > 0),
            CHECK (revision > 0),
            CHECK (status IN ('active', 'disabled', 'revoked'))
          );

          CREATE INDEX IF NOT EXISTS idx_plugin_app_instances_plugin
            ON plugin_app_instances(plugin_id, created_at, instance_id);
          CREATE INDEX IF NOT EXISTS idx_plugin_app_instances_app
            ON plugin_app_instances(plugin_id, app_id, created_at, instance_id);
        `);
      },
    },
  ];

  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  /**
   * Create an instance at revision 1 / `active`. The instance id is Host-minted,
   * so a collision means two Hosts disagree about identity: it is an error,
   * never an upsert.
   */
  create(input: CreatePluginAppInstanceInput): PluginAppInstanceRecord {
    const instanceId = assertNonEmptyId(input.instanceId, 'instanceId');
    const pluginId = assertNonEmptyId(input.pluginId, 'pluginId');
    const appId = assertNonEmptyId(input.appId, 'appId');
    const stateSchemaVersion = assertPositiveInteger(input.stateSchemaVersion, 'stateSchemaVersion');
    const stateJson = serializeState(input.state ?? {});
    const now = Date.now();

    try {
      this.db
        .prepare(
          `INSERT INTO plugin_app_instances (
            instance_id, plugin_id, app_id, state_schema_version,
            state_json, revision, status, created_at, updated_at
          ) VALUES (
            @instance_id, @plugin_id, @app_id, @state_schema_version,
            @state_json, 1, 'active', @created_at, @updated_at
          )`,
        )
        .run({
          instance_id: instanceId,
          plugin_id: pluginId,
          app_id: appId,
          state_schema_version: stateSchemaVersion,
          state_json: stateJson,
          created_at: now,
          updated_at: now,
        });
    } catch (error) {
      if (isPrimaryKeyViolation(error)) {
        throw new PluginAppInstanceStoreError(
          'already_exists',
          `plugin-app-instance-store: instance id "${instanceId}" is already taken.`,
        );
      }
      throw error;
    }

    return this.require(instanceId);
  }

  get(instanceId: string): PluginAppInstanceRecord | null {
    const row = this.db
      .prepare('SELECT * FROM plugin_app_instances WHERE instance_id = ?')
      .get(instanceId) as PluginAppInstanceRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  listByPlugin(pluginId: string): PluginAppInstanceRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM plugin_app_instances WHERE plugin_id = ? ORDER BY created_at, instance_id',
      )
      .all(pluginId) as PluginAppInstanceRow[];
    return rows.map(rowToRecord);
  }

  listByApp(pluginId: string, appId: string): PluginAppInstanceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM plugin_app_instances
          WHERE plugin_id = ? AND app_id = ?
          ORDER BY created_at, instance_id`,
      )
      .all(pluginId, appId) as PluginAppInstanceRow[];
    return rows.map(rowToRecord);
  }

  /**
   * Compare-and-set the opaque state.
   *
   * Rejections, in the order they are decided:
   *   1. `not_found`        — no such instance.
   *   2. `stale_revision`   — the row advanced past `expectedRevision`.
   *   3. `schema_mismatch`  — stored version differs from `expectedSchemaVersion`.
   *   4. `inactive`         — status is not `active`.
   *
   * The payload is validated before any of that, so a state JSON would
   * silently coerce never reaches the table, and a rejected caller leaves the
   * stored payload and revision untouched in every case above.
   */
  writeState(input: WritePluginAppInstanceStateInput): PluginAppInstanceWriteResult {
    const instanceId = assertNonEmptyId(input.instanceId, 'instanceId');
    const expectedRevision = assertPositiveInteger(input.expectedRevision, 'expectedRevision');
    const expectedSchemaVersion = assertPositiveInteger(
      input.expectedSchemaVersion,
      'expectedSchemaVersion',
    );
    const stateJson = serializeState(input.state);

    const run = this.db.transaction((): PluginAppInstanceWriteResult => {
      const current = this.get(instanceId);
      const rejection = classifyWrite(
        current,
        expectedRevision,
        expectedSchemaVersion,
      );
      if (rejection) return rejection;

      const result = this.db
        .prepare(
          `UPDATE plugin_app_instances
              SET state_json = @state_json,
                  revision = revision + 1,
                  updated_at = @updated_at
            WHERE instance_id = @instance_id
              AND revision = @expected_revision
              AND state_schema_version = @expected_schema_version
              AND status = 'active'`,
        )
        .run({
          state_json: stateJson,
          updated_at: Date.now(),
          instance_id: instanceId,
          expected_revision: expectedRevision,
          expected_schema_version: expectedSchemaVersion,
        });

      if (Number(result.changes) !== 1) {
        throw new PluginAppInstanceStoreError(
          'cas_mismatch',
          `plugin-app-instance-store: guarded state write for "${instanceId}" changed no row.`,
        );
      }
      return { ok: true, instance: this.require(instanceId) };
    });

    return run.immediate();
  }

  /**
   * Compare-and-set the status. `active <-> disabled` is reversible;
   * `revoked` is terminal and reports `invalid_transition` for every target.
   * Asking for the status the row already has is an idempotent no-op that
   * still honours `expectedRevision` and does not burn a revision.
   */
  setStatus(input: SetPluginAppInstanceStatusInput): PluginAppInstanceStatusResult {
    const instanceId = assertNonEmptyId(input.instanceId, 'instanceId');
    const expectedRevision = assertPositiveInteger(input.expectedRevision, 'expectedRevision');
    if (!isPluginAppInstanceStatus(input.status)) {
      throw new PluginAppInstanceStoreError(
        'invalid_input',
        `plugin-app-instance-store: unknown status "${String(input.status)}".`,
      );
    }
    const nextStatus = input.status;

    const run = this.db.transaction((): PluginAppInstanceStatusResult => {
      const current = this.get(instanceId);
      if (!current) return { ok: false, reason: 'not_found', instance: null };
      if (current.revision !== expectedRevision) {
        return { ok: false, reason: 'stale_revision', instance: current };
      }
      if (current.status === nextStatus) return { ok: true, instance: current };
      if (current.status === 'revoked') {
        return { ok: false, reason: 'invalid_transition', instance: current };
      }

      const result = this.db
        .prepare(
          `UPDATE plugin_app_instances
              SET status = @status,
                  revision = revision + 1,
                  updated_at = @updated_at
            WHERE instance_id = @instance_id
              AND revision = @expected_revision
              AND status = @from_status`,
        )
        .run({
          status: nextStatus,
          updated_at: Date.now(),
          instance_id: instanceId,
          expected_revision: expectedRevision,
          from_status: current.status,
        });

      if (Number(result.changes) !== 1) {
        throw new PluginAppInstanceStoreError(
          'cas_mismatch',
          `plugin-app-instance-store: guarded status write for "${instanceId}" changed no row.`,
        );
      }
      return { ok: true, instance: this.require(instanceId) };
    });

    return run.immediate();
  }

  private require(instanceId: string): PluginAppInstanceRecord {
    const record = this.get(instanceId);
    if (!record) {
      // Unreachable: the guarded UPDATE above matched this row in the same
      // IMMEDIATE transaction. Reported as a broken invariant, not as a
      // rejection the caller would retry.
      throw new PluginAppInstanceStoreError(
        'cas_mismatch',
        `plugin-app-instance-store: instance "${instanceId}" vanished mid-write.`,
      );
    }
    return record;
  }
}

// ─── Classification ───

/**
 * Decide why a state write may not proceed, in the documented order. `null`
 * means every precondition holds and the write may run.
 */
function classifyWrite(
  current: PluginAppInstanceRecord | null,
  expectedRevision: number,
  expectedSchemaVersion: number,
): Extract<PluginAppInstanceWriteResult, { ok: false }> | null {
  if (!current) return { ok: false, reason: 'not_found', instance: null };
  if (current.revision !== expectedRevision) {
    return { ok: false, reason: 'stale_revision', instance: current };
  }
  if (current.stateSchemaVersion !== expectedSchemaVersion) {
    return { ok: false, reason: 'schema_mismatch', instance: current };
  }
  if (current.status !== 'active') {
    return { ok: false, reason: 'inactive', instance: current };
  }
  return null;
}

// ─── Validation ───

function isPluginAppInstanceStatus(value: unknown): value is PluginAppInstanceStatus {
  return value === 'active' || value === 'disabled' || value === 'revoked';
}

function assertNonEmptyId(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PluginAppInstanceStoreError(
      'invalid_input',
      `plugin-app-instance-store: ${field} must be a non-empty string.`,
    );
  }
  return value;
}

function assertPositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PluginAppInstanceStoreError(
      'invalid_input',
      `plugin-app-instance-store: ${field} must be a positive integer.`,
    );
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Narrow a parsed JSON array without letting the implicit `any[]` leak in. */
function asUnknownArray(value: object): unknown[] {
  return value as unknown[];
}

/**
 * Build a descriptor-read snapshot containing only strict JSON values. Reading
 * `descriptor.value` avoids invoking getters, and serializing the returned
 * snapshot avoids a second read of caller-owned objects after validation.
 *
 * `ancestors` is the current path, not every object ever seen, so a shared
 * (non-circular) reference stays legal exactly as it is for JSON.
 */
function snapshotStrictJsonValue(
  value: unknown,
  at: string,
  ancestors: Set<object>,
): PluginAppInstanceStateValue {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new PluginAppInstanceStoreError(
          'invalid_state',
          `plugin-app-instance-store: ${at} is ${String(value)}, which JSON would rewrite to null.`,
        );
      }
      return value;
    case 'undefined':
    case 'function':
    case 'symbol':
    case 'bigint':
      throw new PluginAppInstanceStoreError(
        'invalid_state',
        `plugin-app-instance-store: ${at} is a ${typeof value}, which is not JSON.`,
      );
    case 'object':
      break;
    default:
      throw new PluginAppInstanceStoreError(
        'invalid_state',
        `plugin-app-instance-store: ${at} has unsupported type ${typeof value}.`,
      );
  }

  if (ancestors.has(value)) {
    throw new PluginAppInstanceStoreError(
      'invalid_state',
      `plugin-app-instance-store: ${at} is circular and cannot be serialized.`,
    );
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const names = Object.getOwnPropertyNames(value);
      const length = value.length;
      // Arrays serialize only dense numeric elements. Reject custom string or
      // symbol keys and holes instead of letting JSON.stringify discard/fill
      // them. `length` is the one permitted built-in non-enumerable property.
      if (Object.getOwnPropertySymbols(value).length > 0 || names.length !== length + 1 ||
          names.some((key) => key !== 'length' && !isArrayIndex(key, length))) {
        throw new PluginAppInstanceStoreError(
          'invalid_state',
          `plugin-app-instance-store: ${at} has array properties JSON would omit or rewrite.`,
        );
      }
      const snapshot: PluginAppInstanceStateValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw new PluginAppInstanceStoreError(
            'invalid_state',
            `plugin-app-instance-store: ${at}[${index}] must be an enumerable data property.`,
          );
        }
        snapshot.push(snapshotStrictJsonValue(descriptor.value, `${at}[${index}]`, ancestors));
      }
      return snapshot;
    }
    if (!isPlainObject(value)) {
      throw new PluginAppInstanceStoreError(
        'invalid_state',
        `plugin-app-instance-store: ${at} is not a plain JSON object.`,
      );
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new PluginAppInstanceStoreError(
        'invalid_state',
        `plugin-app-instance-store: ${at} carries symbol keys, which JSON drops.`,
      );
    }
    const snapshot: Record<string, PluginAppInstanceStateValue> = Object.create(null) as Record<
      string,
      PluginAppInstanceStateValue
    >;
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new PluginAppInstanceStoreError(
          'invalid_state',
          `plugin-app-instance-store: ${at}.${key} must be an enumerable data property.`,
        );
      }
      snapshot[key] = snapshotStrictJsonValue(descriptor.value, `${at}.${key}`, ancestors);
    }
    return snapshot;
  } finally {
    ancestors.delete(value);
  }
}

function isArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

/** Serialize validated state, or throw. Never returns a coerced payload. */
function serializeState(state: PluginAppInstanceState): string {
  if (!isPlainObject(state)) {
    throw new PluginAppInstanceStoreError(
      'invalid_state',
      'plugin-app-instance-store: state must be a plain JSON object.',
    );
  }
  const snapshot = snapshotStrictJsonValue(state, 'state', new Set());
  const json = JSON.stringify(snapshot);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > PLUGIN_APP_INSTANCE_STATE_MAX_BYTES) {
    throw new PluginAppInstanceStoreError(
      'state_too_large',
      `plugin-app-instance-store: state is ${bytes} bytes, over the ${PLUGIN_APP_INSTANCE_STATE_MAX_BYTES} byte limit.`,
    );
  }
  return json;
}

/** Narrow parsed JSON without asserting anything about its contents. */
function isJsonValue(value: unknown): value is PluginAppInstanceStateValue {
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      break;
    default:
      return false;
  }
  if (Array.isArray(value)) return asUnknownArray(value).every(isJsonValue);
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function parseState(json: string, instanceId: string): PluginAppInstanceState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new PluginAppInstanceStoreError(
      'corrupt_state',
      `plugin-app-instance-store: state for "${instanceId}" is not valid JSON.`,
    );
  }
  if (!isPlainObject(parsed) || !isJsonValue(parsed)) {
    throw new PluginAppInstanceStoreError(
      'corrupt_state',
      `plugin-app-instance-store: state for "${instanceId}" is not a JSON object.`,
    );
  }
  return parsed;
}

function isPrimaryKeyViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === 'SQLITE_CONSTRAINT_UNIQUE';
}

function rowToRecord(row: PluginAppInstanceRow): PluginAppInstanceRecord {
  return {
    instanceId: row.instance_id,
    pluginId: row.plugin_id,
    appId: row.app_id,
    stateSchemaVersion: row.state_schema_version,
    state: parseState(row.state_json, row.instance_id),
    revision: row.revision,
    status: row.status as PluginAppInstanceStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
