/**
 * The Control Plane's own guarantees: a manifest that is frozen and
 * fingerprintable, and a run record that is durable and one-shot.
 *
 * These run against a real `better-sqlite3` database rather than a mock. The
 * properties under test ARE the schema — a `(run_id, seq)` primary key that
 * silently accepted a duplicate, or a terminal `UPDATE` without a `WHERE`,
 * would be invisible behind a `vi.fn()`, and both are the entire reason this
 * store exists.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunEventEnvelope } from '@duya/agent-protocol';
import { manifestFingerprint, type RunManifest } from '@duya/agent-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRunManifest } from '../control-plane/manifest-factory';
import { RunStore, RUN_STORE_MIGRATIONS } from '../db/core/run-store';

let db: Database.Database;
let store: RunStore;
let dir: string;

function openStore(): void {
  dir = mkdtempSync(join(tmpdir(), 'duya-run-store-'));
  db = new Database(join(dir, 'core.db'));
  for (const migration of [...RUN_STORE_MIGRATIONS].sort((a, b) => a.id - b.id)) {
    migration.up(db);
  }
  store = new RunStore(db);
}

function envelope(runId: string, seq: number, type: string): RunEventEnvelope {
  return {
    runId,
    sessionId: 's-1',
    seq,
    timestamp: 0,
    traceId: 't',
    payload: { type: 'run.started', manifestHash: 'h', protocol: { major: 1, minor: 0 }, runtime: { name: 'r', version: '1' } },
    ...(type === 'override' ? {} : {}),
  } as RunEventEnvelope;
}

const intent = {
  sessionId: 'session-1',
  workingDirectory: '/repo',
  additionalRoots: ['/repo/packages', '/repo'],
  model: 'claude-opus',
  providerId: 'anthropic-main',
  maxTurns: 12,
};

describe('buildRunManifest', () => {
  it('freezes the manifest so its fingerprint cannot drift', () => {
    const { manifest, manifestHash } = buildRunManifest(intent);
    expect(manifestFingerprint(manifest)).toBe(manifestHash);
    // A nested mutation is what would break the hash. `capabilities` is nested
    // one level below the top-level freeze, so it is the case worth asserting.
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.capabilities)).toBe(true);
    expect(Object.isFrozen(manifest.permissionPolicy)).toBe(true);
  });

  it('produces the same fingerprint for the same intent', () => {
    const a = buildRunManifest({ ...intent, runId: 'fixed' });
    const b = buildRunManifest({ ...intent, runId: 'fixed' });
    expect(a.manifestHash).toBe(b.manifestHash);
  });

  it('deduplicates roots and puts the working directory first', () => {
    const { manifest } = buildRunManifest({ ...intent, runId: 'fixed' });
    // `/repo` appears in both the cwd and additionalRoots. A duplicate would
    // make two structurally different manifests describe one execution.
    expect(manifest.roots).toEqual(['/repo', '/repo/packages']);
    expect(manifest.cwd).toBe('/repo');
  });

  it('omits permission rules rather than serialising an empty object', () => {
    const { manifest } = buildRunManifest({ ...intent, runId: 'fixed' });
    // The in-repo permission context holds a ReadonlyMap, and a Map
    // serialises to `{}`. An absent `rules` says "none supplied", which is
    // true; a `{}` would say the same while hiding that no conversion ran.
    expect(manifest.permissionPolicy.rules).toBeUndefined();
  });

  it('carries no connector binding rather than an invented scope', () => {
    const { manifest } = buildRunManifest({ ...intent, runId: 'fixed' });
    expect(manifest.connectorBindings).toEqual([]);
  });

  it('carries an env REFERENCE, never a value', () => {
    const { manifest } = buildRunManifest({ ...intent, runId: 'fixed' });
    expect(manifest.env.ref).toBe('env:session-1');
    expect(JSON.stringify(manifest)).not.toMatch(/sk-|api[_-]?key|secret/i);
  });

  it('maps only the budget ceiling something measures today', () => {
    const { manifest } = buildRunManifest({ ...intent, runId: 'fixed' });
    expect(manifest.budget).toEqual({ maxTurns: 12 });
  });

  it('reports deterministic:false, because nothing here is reproducible', () => {
    // A deterministic run uses a virtual clock. The current run carries a wall
    // clock and a live worker pid, so claiming true would be a lie the
    // timestamp contract would then act on.
    expect(buildRunManifest({ ...intent, runId: 'fixed' }).manifest.deterministic).toBe(false);
  });

  it('omits the agent selection when the host resolved no model', () => {
    const { manifest } = buildRunManifest({ sessionId: 's', workingDirectory: '/r', runId: 'fixed' });
    expect(manifest.agent).toBeUndefined();
  });

  it('carries a null projectId rather than an empty string', () => {
    const { manifest } = buildRunManifest({ sessionId: 's', workingDirectory: '/r', runId: 'fixed' });
    expect(manifest.projectId).toBeNull();
  });
});

describe('RunStore', () => {
  beforeEach(openStore);
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens a run in the running state', () => {
    const { runId, manifest, manifestHash } = buildRunManifest(intent);
    store.createRun({ runId, sessionId: 'session-1', manifest, manifestHash });
    const row = store.getRun(runId);
    expect(row?.status).toBe('running');
    expect(row?.manifest_hash).toBe(manifestHash);
  });

  it('stores the manifest verbatim so it can be re-fingerprinted', () => {
    const { runId, manifest, manifestHash } = buildRunManifest(intent);
    store.createRun({ runId, sessionId: 'session-1', manifest, manifestHash });
    expect(store.verifyManifest(runId)).toEqual({ ok: true, expected: manifestHash, actual: manifestHash });
  });

  it('detects a manifest edited after it was recorded', () => {
    const { runId, manifest, manifestHash } = buildRunManifest(intent);
    store.createRun({ runId, sessionId: 'session-1', manifest, manifestHash });
    db.prepare('UPDATE runs SET manifest_json = ? WHERE id = ?').run(
      JSON.stringify({ ...(manifest as RunManifest), cwd: '/somewhere/else' }),
      runId,
    );
    // The check that makes `manifest_json` worth storing: two columns written
    // together, verified independently. A mismatch means a resume is unsafe.
    expect(store.verifyManifest(runId)?.ok).toBe(false);
  });

  it('appends durable events keyed on (run_id, seq)', () => {
    const { runId, manifest, manifestHash } = buildRunManifest(intent);
    store.createRun({ runId, sessionId: 'session-1', manifest, manifestHash });
    const written = store.appendEvents([envelope(runId, 1, 'a'), envelope(runId, 2, 'b')]);
    expect(written).toBe(2);
    expect(store.countEvents(runId)).toBe(2);
  });

  it('treats a re-delivered batch as a no-op, not a second record', () => {
    const { runId, manifest, manifestHash } = buildRunManifest(intent);
    store.createRun({ runId, sessionId: 'session-1', manifest, manifestHash });
    const batch = [envelope(runId, 1, 'a'), envelope(runId, 2, 'b')];
    store.appendEvents(batch);
    // The Control Plane cannot know whether a timed-out append landed, so it
    // retries. Without IGNORE the retry would be a constraint failure that
    // looks like a bug in the run layer.
    expect(store.appendEvents(batch)).toBe(0);
    expect(store.countEvents(runId)).toBe(2);
  });

  it('reads events from an exclusive sequence cursor', () => {
    const { runId, manifest, manifestHash } = buildRunManifest(intent);
    store.createRun({ runId, sessionId: 'session-1', manifest, manifestHash });
    store.appendEvents([1, 2, 3, 4].map((n) => envelope(runId, n, 'a')));
    expect(store.listEvents(runId, 0).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    // Exclusive, so a reconnecting host passes the last seq it holds and gets
    // exactly what it is missing.
    expect(store.listEvents(runId, 2).map((e) => e.seq)).toEqual([3, 4]);
  });

  it('records a terminal state once', () => {
    const { runId, manifest, manifestHash } = buildRunManifest(intent);
    store.createRun({ runId, sessionId: 'session-1', manifest, manifestHash });
    expect(store.completeRun(runId, { status: 'completed' })).toBe(true);
    expect(store.getRun(runId)?.status).toBe('completed');
  });

  it('refuses a second terminal write rather than overwriting a decided history', () => {
    const { runId, manifest, manifestHash } = buildRunManifest(intent);
    store.createRun({ runId, sessionId: 'session-1', manifest, manifestHash });
    store.completeRun(runId, { status: 'completed' });
    // The CAS. A late `done` frame, a timeout sweep and a cancel can all race
    // for this row; the first writer wins and the others learn they lost.
    expect(store.completeRun(runId, { status: 'failed', error: { code: 'internal', message: 'late' } })).toBe(false);
    expect(store.getRun(runId)?.status).toBe('completed');
    expect(store.getRun(runId)?.error_json).toBeNull();
  });

  it('stores a failure error and leaves it null for the other arms', () => {
    const failed = buildRunManifest({ ...intent, runId: 'r-fail' });
    store.createRun({ runId: failed.runId, sessionId: 'session-1', manifest: failed.manifest, manifestHash: failed.manifestHash });
    store.completeRun(failed.runId, { status: 'failed', error: { code: 'provider_auth', message: 'bad key' } });
    expect(JSON.parse(store.getRun(failed.runId)?.error_json ?? '{}').code).toBe('provider_auth');

    const cancelled = buildRunManifest({ ...intent, runId: 'r-cancel' });
    store.createRun({ runId: cancelled.runId, sessionId: 'session-1', manifest: cancelled.manifest, manifestHash: cancelled.manifestHash });
    store.completeRun(cancelled.runId, { status: 'cancelled' });
    // Cancelling is not a failure, so there is no error to record.
    expect(store.getRun(cancelled.runId)?.error_json).toBeNull();
  });

  it('lists a session runs newest first, which is the session-as-projection read', () => {
    const a = buildRunManifest({ ...intent, runId: 'r-a' });
    const b = buildRunManifest({ ...intent, runId: 'r-b' });
    store.createRun({ runId: a.runId, sessionId: 'session-1', manifest: a.manifest, manifestHash: a.manifestHash });
    store.createRun({ runId: b.runId, sessionId: 'session-1', manifest: b.manifest, manifestHash: b.manifestHash });
    const rows = store.listRunsBySession('session-1');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.created_at).toBeGreaterThanOrEqual(rows[1]?.created_at ?? 0);
  });

  it('keeps two runs in one session on independent event spaces', () => {
    const a = buildRunManifest({ ...intent, runId: 'shared-a' });
    const b = buildRunManifest({ ...intent, runId: 'shared-b' });
    store.createRun({ runId: a.runId, sessionId: 'session-1', manifest: a.manifest, manifestHash: a.manifestHash });
    store.createRun({ runId: b.runId, sessionId: 'session-1', manifest: b.manifest, manifestHash: b.manifestHash });
    // Both runs use seq 1..2. With the run in the key that is legal, and it is
    // the property the session-wide SSE counter lacks.
    store.appendEvents([envelope('shared-a', 1, 'a'), envelope('shared-a', 2, 'a')]);
    store.appendEvents([envelope('shared-b', 1, 'a'), envelope('shared-b', 2, 'a')]);
    expect(store.countEvents('shared-a')).toBe(2);
    expect(store.countEvents('shared-b')).toBe(2);
  });

  it('uses migration ids above the measured core maximum', () => {
    // The `id <= current` guard in runMigrations silently skipped an id that
    // collided with a recorded schema_version, and that shipped as a missing
    // `session_runtime_locks.origin` column. 35/36/37 are chosen by measurement.
    //
    // This is an exact list on purpose, not a range: it is the assertion that a
    // future migration landing on an id already in use FAILS HERE rather than
    // colliding at boot. R1.3 added 37 for `runs.input_hash`; the next one has
    // to be measured again, not assumed to be 38.
    expect(RUN_STORE_MIGRATIONS.map((m) => m.id)).toEqual([35, 36, 37]);
  });
});
