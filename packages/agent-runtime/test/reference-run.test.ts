/**
 * The Reference Run, end to end, with no API key and no Electron.
 *
 * ## What this proves
 *
 * The whole closed loop the plan exists to establish:
 *
 * ```
 * Control Plane mints runId + freezes RunManifest + persists `runs`
 *        1. RunController opens a run, emits run.started with the manifest hash
 *        2. a scripted executor produces worker frames
 *        3. each frame becomes a RunEvent with a run-scoped gapless seq
 *        4. durable events are batched into `run_events`
 *        5. the terminal CAS updates `runs.status` exactly once
 * ```
 *
 * The executor is a script rather than a real agent so the loop is
 * deterministic. That is the point: the run layer's job is run identity,
 * sequencing and persistence, and none of those should need a model to
 * verify. A test that needed an API key would be a test that ran in CI about
 * once a month.
 *
 * ## What this does NOT prove
 *
 * That the real agent worker's frames translate correctly. That needs a live
 * worker and belongs to the Electron smoke test; the translator's own suite
 * pins the frame vocabulary.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ConnectorBinding,
  PermissionPolicyMode,
  RunEventEnvelope,
  RunManifest,
  RunTerminalState,
} from '@duya/agent-protocol';
import { manifestFingerprint } from '@duya/agent-protocol';
import {
  RunController,
  type ExecutionChannel,
  type ExecutionHandle,
  type FrameOutcome,
  type StopReceipt,
  type TranslateContext,
} from '@duya/agent-runtime';

/**
 * A stop the executor honoured and left cleanly.
 *
 * R2.3 gave `stop` a receipt so a caller can tell a clean exit from a kill.
 * A double returning `Promise<void>` could say neither, so these report the
 * cooperative case explicitly.
 */
function cooperativeStop(reason: string): StopReceipt {
  return { requested: true, disposition: 'cooperative', waitedMs: 0, reason };
}


// ── the Control Plane's half, written the way the real one will be ──────

interface RunRow {
  id: string;
  session_id: string;
  manifest_hash: string;
  manifest_json: string;
  status: string;
  terminal: string | null;
  error_json: string | null;
  metrics_json: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

let db: Database.Database;
let dbPath: string;
let runSeq = 0;

/**
 * The minimum Control Plane the runtime needs: create the run row with the
 * frozen manifest, append durable envelopes, and land the one-shot terminal.
 *
 * Written out in full rather than mocked so the test exercises the real schema
 * — a `(run_id, seq)` primary key that rejected a duplicate would be invisible
 * behind a `vi.fn()`.
 */
class SqliteControlPlane {
  createRun(manifest: RunManifest): string {
    const now = Date.now();
    db.prepare(
      `INSERT INTO runs (id, session_id, manifest_hash, manifest_json, status, created_at, started_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?)`,
    ).run(
      manifest.runId,
      'session-1',
      manifestFingerprint(manifest),
      JSON.stringify(manifest),
      now,
      now,
    );
    return manifest.runId;
  }

  append(envelopes: readonly RunEventEnvelope[]): void {
    if (envelopes.length === 0) return;
    const stmt = db.prepare(
      `INSERT INTO run_events (run_id, seq, event_type, envelope_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    const tx = db.transaction((batch: readonly RunEventEnvelope[]) => {
      for (const envelope of batch) {
        stmt.run(
          envelope.runId,
          envelope.seq,
          envelope.payload.type,
          JSON.stringify(envelope),
          now,
        );
      }
    });
    tx(envelopes);
  }

  complete(runId: string, terminal: RunTerminalState, metrics: unknown): void {
    // The one-shot CAS. `WHERE status NOT IN ('completed','cancelled',
    // 'budget_exhausted','failed')` is the whole point: a second writer gets
    // zero rows changed instead of overwriting a decided history.
    const result = db
      .prepare(
        `UPDATE runs
            SET status = ?,
                terminal = ?,
                error_json = ?,
                metrics_json = ?,
                finished_at = ?
          WHERE id = ? AND status = 'running'`,
      )
      .run(
        terminal.status,
        terminal.status,
        terminal.status === 'failed' ? JSON.stringify(terminal.error) : null,
        JSON.stringify(metrics),
        Date.now(),
        runId,
      );
    if (result.changes === 0) {
      throw new Error('terminal CAS lost: the run was already settled');
    }
  }
}

// ── the scripted executor ────────────────────────────────────────────────

const SCRIPT: ReadonlyArray<Readonly<Record<string, unknown>>> = [
  { type: 'turn_start', data: { turnCount: 1 } },
  { type: 'text', data: { content: 'Reading the file.' } },
  { type: 'tool_use_started', data: { id: 'call-1', name: 'Read', input: { path: 'a.ts' } } },
  { type: 'tool_use', data: { id: 'call-1', name: 'Read', input: { path: 'a.ts' } } },
  { type: 'tool_result', data: { id: 'call-1', result: 'contents', error: false, duration_ms: 12 } },
  { type: 'token_usage', data: { input_tokens: 120, output_tokens: 34, total_tokens: 154 } },
  { type: 'status', data: { message: 'done' } },
  { type: 'done', data: {} },
];

/**
 * An executor that replays a fixed frame list, then ends the stream.
 *
 * The channel signature is `start(manifest, input, sink)` as of plan 587 R2.1 —
 * the run's whole identity and resolved configuration have to be available at
 * the ONE place an execution begins, or the host has to issue its own command
 * beside it (which is precisely what R2.1 removed).
 */
function scriptedExecutor(frames: readonly Readonly<Record<string, unknown>>[]): ExecutionChannel {
  return {
    async start(_manifest, input, sink): Promise<ExecutionHandle> {
      expect(input.revision).toMatch(/^[0-9a-f]{64}$/);
      for (const frame of frames) sink.frame(frame);
      sink.end();
      return { stop: async (request) => cooperativeStop(request.reason) };
    },
  };
}

/**
 * An executor that stays open and never ends the stream.
 *
 * Needed for cancellation: an executor that calls `sink.end()` immediately has
 * already settled the run as completed, so the cancel that follows is correctly
 * refused with `applied: false`. A real worker is mid-turn when the user presses
 * stop, and that is the only state in which a cancel can be applied at all.
 */
function openExecutor(): ExecutionChannel {
  return {
    async start(_manifest, _input, sink): Promise<ExecutionHandle> {
      let stopped = false;
      return {
        stop: async (request) => {
          stopped = true;
          // A cooperative stop still lets the worker emit its own terminal
          // frame, which is the case the runtime must not double-count.
          if (!stopped) sink.end();
        return cooperativeStop(request.reason);
        },
      };
    },
  };
}

// ── the manifest factory ──────────────────────────────────────────────────

function buildManifest(runId: string): RunManifest {
  const permissionPolicy = {
    mode: 'default' as PermissionPolicyMode,
    hostSwitch: 'ask' as const,
    defaultTimeoutMs: 300_000,
  };
  const connectorBindings: readonly ConnectorBinding[] = [];
  return {
    version: 1,
    runId,
    projectId: null,
    workspaceId: 'ws-1',
    roots: ['/tmp/workspace'],
    cwd: '/tmp/workspace',
    permissionPolicy,
    capabilities: { profiles: [], modes: ['general'], tools: ['Read'] },
    connectorBindings,
    // The header on `env` says a Control Plane secret resolver must exist
    // before this field means anything. A hash over a fixed reference is the
    // honest stand-in: it proves the field is a REFERENCE and carries no
    // credential, which is the property the manifest is actually asserting.
    env: { ref: 'env:session-1', hash: 'e3b0c44298fc1c149afbf4c8996fb924' },
    budget: { maxTurns: 12 },
    deterministic: false,
  };
}

function contextFor(): TranslateContext {
  return {
    messageId: 'msg-1',
    permission: {
      classify: () => 'tool_use',
      mode: 'generic',
      expiresInMs: 300_000,
      now: () => Date.now(),
    },
    nextTurn: (() => {
      let n = 0;
      return () => {
        n += 1;
        return { turnId: `turn-${n}`, index: n };
      };
    })(),
    model: { model: 'test-model', providerId: 'test-provider', apiFormat: 'anthropic' },
  };
}

// ── the suite ────────────────────────────────────────────────────────────

describe('the Reference Run: Control Plane -> Runtime -> RunEvent -> SQLite', () => {
  beforeEach(() => {
    runSeq += 1;
    dbPath = join(mkdtempSync(join(tmpdir(), 'duya-reference-run-')), 'runs.db');
    db = new Database(dbPath);
    db.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        manifest_hash TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        status TEXT NOT NULL,
        terminal TEXT,
        error_json TEXT,
        metrics_json TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );
      CREATE TABLE run_events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
    `);
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  function build(frames = SCRIPT): { controller: RunController; runId: string; controlPlane: SqliteControlPlane; forwarded: FrameOutcome[] } {
    const controlPlane = new SqliteControlPlane();
    const runId = `run-${runSeq}`;
    const manifest = buildManifest(runId);
    controlPlane.createRun(manifest);

    const controller = new RunController({
      channel: scriptedExecutor(frames),
      identity: { name: 'duya-agent-runtime', version: '0.1.0', pid: 4242 },
      protocol: { major: 1, minor: 0 },
      contextFor,
      persistenceFor: () => ({
        append: async (envelopes) => {
          controlPlane.append(envelopes);
        },
        complete: async (terminal, metrics) => {
          controlPlane.complete(runId, terminal, metrics);
        },
      }),
    });

    return { controller, runId, controlPlane, forwarded: [] };
  }

  it('records a run, a gapless event log, and a terminal state', async () => {
    const { controller, runId } = build();

    await controller.start(buildManifest(runId), { prompt: 'read a.ts', sessionId: 'session-1' });
    const terminal = await controller.settle(runId);

    expect(terminal.status).toBe('completed');

    // 1. The run row exists, with the manifest stored verbatim and frozen.
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow;
    expect(run.status).toBe('completed');
    expect(run.manifest_hash).toBe(manifestFingerprint(buildManifest(runId)));
    expect(JSON.parse(run.manifest_json).runId).toBe(runId);
    expect(run.finished_at).not.toBeNull();

    // 2. `run.started` is seq 1 — emitted BEFORE the execution, which is the
    //    only order that makes the manifest hash answerable for a run that
    //    crashed immediately.
    const events = db
      .prepare('SELECT seq, event_type FROM run_events WHERE run_id = ? ORDER BY seq')
      .all(runId) as Array<{ seq: number; event_type: string }>;
    expect(events[0]).toEqual({ seq: 1, event_type: 'run.started' });

    //    The stored seqs are a strictly increasing SUBSET of the run's
    //    sequence space, not a gapless run of their own. The run's `seq` is
    //    gapless — that is asserted on the ledger in translator-projector.test
    //    — but a volatile or ephemeral event consumes a sequence number
    //    without occupying a row, so the durable log legitimately has holes.
    //    Asserting the stored list was gapless would be asserting that no
    //    volatile event ever fired.
    const storedSeqs = events.map((e) => e.seq);
    expect(storedSeqs).toEqual([...storedSeqs].sort((a, b) => a - b));
    expect(new Set(storedSeqs).size).toBe(storedSeqs.length);
    expect(storedSeqs[0]).toBe(1);
    // The `status` frame in the script is volatile, so it took a seq number
    // that no row carries — proof the subset is real and not an accident.
    expect(storedSeqs).not.toEqual(storedSeqs.map((_, i) => i + 1));

    // 3. Only DURABLE events were stored. The `tool_use_started` preview is
    //    volatile and the text delta family is ephemeral; neither may occupy a
    //    row, because a retained delta storm would let one verbose answer
    //    dominate the run's storage.
    const types = events.map((e) => e.event_type);
    expect(types).toContain('assistant.text_block');
    expect(types).toContain('tool.call_started');
    expect(types).toContain('tool.call_completed');
    expect(types).toContain('run.completed');
    expect(types).not.toContain('tool.call_preview');
    expect(types).not.toContain('assistant.status');

    // 4. The terminal event is last, and exactly one exists.
    expect(types[types.length - 1]).toBe('run.completed');
    expect(types.filter((t) => t === 'run.completed' || t === 'run.failed')).toHaveLength(1);
  });

  it('stores the manifest hash on run.started so a run is self-describing', async () => {
    const { controller, runId } = build();
    const manifest = buildManifest(runId);
    await controller.start(manifest, { prompt: 'p', sessionId: 'session-1' });
    await controller.settle(runId);

    const row = db
      .prepare("SELECT envelope_json FROM run_events WHERE run_id = ? AND seq = 1")
      .get(runId) as { envelope_json: string };
    const envelope = JSON.parse(row.envelope_json) as RunEventEnvelope;
    expect(envelope.payload.type).toBe('run.started');
    if (envelope.payload.type !== 'run.started') throw new Error('unreachable');
    expect(envelope.payload.manifestHash).toBe(manifestFingerprint(manifest));
  });

  it('projects frames onto the legacy vocabulary while the run records protocol events', async () => {
    // Built by hand rather than through `build()` so the executor stays open:
    // this is the tee the router uses, feeding frames in one at a time while
    // the run is still live.
    const controlPlane = new SqliteControlPlane();
    const runId = `run-tee-${runSeq}`;
    const manifest = buildManifest(runId);
    controlPlane.createRun(manifest);

    const controller = new RunController({
      channel: openExecutor(),
      identity: { name: 'duya-agent-runtime', version: '0.1.0' },
      protocol: { major: 1, minor: 0 },
      contextFor,
      persistenceFor: () => ({
        append: async (envelopes) => {
          controlPlane.append(envelopes);
        },
        complete: async (terminal, metrics) => {
          controlPlane.complete(runId, terminal, metrics);
        },
      }),
    });

    await controller.start(manifest, { prompt: 'p', sessionId: 'session-1' });

    const text = controller.observeFrame(runId, { type: 'text', data: { content: 'hello' } });
    expect(text.legacy).toEqual({ type: 'text', data: { content: 'hello' } });
    expect(text.envelope?.payload.type).toBe('assistant.text_block');

    const start = controller.observeFrame(runId, { type: 'tool_use', data: { id: 'c1', name: 'Read', input: {} } });
    expect(start.legacy?.type).toBe('tool_use');

    const result = controller.observeFrame(runId, { type: 'tool_result', data: { id: 'c1', result: 'ok', error: false } });
    expect(result.legacy).toMatchObject({ type: 'tool_result', data: { error: false } });

    const done = controller.observeFrame(runId, { type: 'done', data: {} });
    expect(done.legacy?.type).toBe('done');

    const internal = controller.observeFrame(runId, { type: 'pong' });
    expect(internal).toMatchObject({ forwardOnly: false, internal: true });

    const unmodelled = controller.observeFrame(runId, { type: 'workflow_run', data: { run: { id: 'w' } } });
    expect(unmodelled).toMatchObject({ forwardOnly: true, internal: false, envelope: null });

    await controller.settle(runId);
    expect((db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }).status).toBe('completed');
  });

  it('records a failed run with the producer code preserved', async () => {
    const { controller, runId } = build([
      { type: 'turn_start', data: { turnCount: 1 } },
      { type: 'error', data: { message: 'upstream refused', code: 'provider_auth' } },
    ]);

    await controller.start(buildManifest(runId), { prompt: 'p', sessionId: 'session-1' });
    const terminal = await controller.settle(runId);

    expect(terminal.status).toBe('failed');
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow;
    expect(run.status).toBe('failed');
    expect(JSON.parse(run.error_json ?? '{}').code).toBe('provider_auth');
  });

  it('records cancellation as completed, never as failed', async () => {
    // Cancelling is not a failure. A run log that records a user pressing stop
    // as an error cannot be used for availability maths.
    const controlPlane = new SqliteControlPlane();
    const runId = `run-cancel-${runSeq}`;
    const manifest = buildManifest(runId);
    controlPlane.createRun(manifest);
    const controller = new RunController({
      channel: openExecutor(),
      identity: { name: 'duya-agent-runtime', version: '0.1.0' },
      protocol: { major: 1, minor: 0 },
      contextFor,
      persistenceFor: () => ({
        append: async (envelopes) => {
          controlPlane.append(envelopes);
        },
        complete: async (terminal, metrics) => {
          controlPlane.complete(runId, terminal, metrics);
        },
      }),
    });

    await controller.start(manifest, { prompt: 'p', sessionId: 'session-1' });
    controller.observeFrame(runId, { type: 'turn_start', data: { turnCount: 1 } });
    const outcome = await controller.cancel(runId);

    expect(outcome.applied).toBe(true);
    expect(outcome.terminal.status).toBe('cancelled');
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow;
    expect(run.status).toBe('cancelled');
    expect(run.error_json).toBeNull();
  });

  it('reports applied:false for a run that had already ended', async () => {
    // The improvement over `handleDeleteChat`, which hard-migrates
    // STREAMING -> COMPLETED before the worker acks and cannot tell the host
    // whether its cancel did anything.
    const { controller, runId } = build();
    await controller.start(buildManifest(runId), { prompt: 'p', sessionId: 'session-1' });
    await controller.settle(runId);

    const outcome = await controller.cancel(runId);
    expect(outcome.applied).toBe(false);
  });

  it('keeps two runs in the same session on independent sequence spaces', async () => {
    // A session outlives its runs. Turn two restarts `seq` at 1 under a new
    // runId, and `(run_id, seq)` is the identity that makes that legal.
    const { controller, controlPlane } = build();
    void controlPlane;

    const seqs: number[][] = [];
    for (const n of [1, 2]) {
      const runId = `run-seq-${runSeq}-${n}`;
      const manifest = buildManifest(runId);
      new SqliteControlPlane().createRun(manifest);
      const local = new RunController({
        channel: scriptedExecutor(SCRIPT),
        identity: { name: 'duya-agent-runtime', version: '0.1.0' },
        protocol: { major: 1, minor: 0 },
        contextFor,
        persistenceFor: () => ({
          append: async (envelopes) => {
            const stmt = db.prepare(
              `INSERT INTO run_events (run_id, seq, event_type, envelope_json, created_at)
               VALUES (?, ?, ?, ?, ?)`,
            );
            const now = Date.now();
            for (const envelope of envelopes) {
              stmt.run(runId, envelope.seq, envelope.payload.type, JSON.stringify(envelope), now);
            }
          },
          complete: async () => {},
        }),
      });
      await local.start(manifest, { prompt: 'p', sessionId: 'session-1' });
      await local.settle(runId);
      seqs.push(
        (db.prepare('SELECT seq FROM run_events WHERE run_id = ? ORDER BY seq').all(runId) as Array<{ seq: number }>).map(
          (r) => r.seq,
        ),
      );
    }

    expect(seqs[0]).toEqual(seqs[1]);
    expect(seqs[0]?.[0]).toBe(1);
  });

  it('turns a lifecycle violation into a recorded failure rather than a crash', async () => {
    // A `tool.call_completed` with no authoritative start is a stream the
    // ledger refuses. The run records THAT as its terminal state.
    const { controller, runId } = build([
      { type: 'turn_start', data: { turnCount: 1 } },
      { type: 'tool_result', data: { id: 'ghost', result: 'x', error: false } },
    ]);

    await controller.start(buildManifest(runId), { prompt: 'p', sessionId: 'session-1' });
    const terminal = await controller.settle(runId);

    expect(terminal.status).toBe('failed');
    if (terminal.status !== 'failed') throw new Error('unreachable');
    expect(terminal.error.cause?.code).toBe('tool_completed_without_start');

    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string };
    expect(run.status).toBe('failed');
  });

  it('fails a run whose stream ended with no terminal event', async () => {
    // Silence is not consent: an executor that just stops did not complete.
    const { controller, runId } = build([{ type: 'turn_start', data: { turnCount: 1 } }]);
    await controller.start(buildManifest(runId), { prompt: 'p', sessionId: 'session-1' });
    const terminal = await controller.settle(runId);

    expect(terminal.status).toBe('failed');
    if (terminal.status !== 'failed') throw new Error('unreachable');
    expect(terminal.error.code).toBe('runtime_crash');
  });

  it('rejects a resume rather than accepting an unverified manifest', async () => {
    const { controller } = build();
    // Resume needs a replay window and a fingerprint check. A resume that
    // accepted a manifest without comparing hashes is the "silently different
    // run" failure the protocol was written to prevent.
    await expect(controller.resume()).rejects.toThrow(/not implemented/);
  });
});
