import { describe, expect, it } from 'vitest';
import { canonicalJson, computeDefinitionHash, computeReqHash, type WorkflowHashPort } from '../src/hash.js';
import { Journal } from '../src/journal.js';
import { ConcurrencyGate, readyNodes } from '../src/scheduler.js';
import { isResumeTokenPayload } from '../src/resume-token.js';

let lastHashedInput = '';
const digest: WorkflowHashPort = { sha256: (value) => { lastHashedInput = value; return 'a'.repeat(64); } };

describe('@duya/workflow pure contracts', () => {
  it('canonicalizes nested keys and hashes the full definition and requests', () => {
    expect(canonicalJson({ z: 1, a: { y: true, x: 2 } })).toBe('{"a":{"x":2,"y":true},"z":1}');
    expect(computeDefinitionHash({ z: 1, a: 2 }, digest)).toBe('a'.repeat(64));
    expect(lastHashedInput).toBe('{"a":2,"z":1}');
    expect(computeReqHash('tool', { z: 1, a: 2 }, digest)).toBe('a'.repeat(16));
    expect(lastHashedInput).toBe('tool\u0000{"a":2,"z":1}');
  });

  it('replays successful journal entries and trims a replayable failure tail', () => {
    let now = 10;
    const journal = Journal.memory({ nowMs: () => now++ });
    journal.append({ kind: 'node_result', nodeId: 'a', attempt: 1, reqHash: 'req-a', status: 'succeeded', result: 1 });
    journal.append({ kind: 'node_result', nodeId: 'b', attempt: 1, status: 'failed', result: null });
    expect(journal.hit('a', 'req-a')?.result).toBe(1);
    expect(journal.pruneTrailingFailures()).toBe(1);
    expect(journal.all().map((record) => record.nodeId)).toEqual(['a']);
    expect(journal.append({ kind: 'phase', nodeId: 'done', attempt: 1, status: 'succeeded', result: null }).atMs).toBe(12);
  });

  it('prunes unresolved failure markers around independent replay results', () => {
    const journal = Journal.memory({ nowMs: () => 1 });
    journal.append({ kind: 'phase', nodeId: 'work', attempt: 1, status: 'running', result: null });
    journal.append({ kind: 'node_result', nodeId: 'broken', attempt: 1, status: 'failed', result: null });
    journal.append({ kind: 'node_result', nodeId: 'steady', attempt: 1, reqHash: 'steady-key', status: 'succeeded', result: 'kept' });
    journal.append({ kind: 'node_result', nodeId: 'blocked', attempt: 1, status: 'skipped', errorClass: 'dependency_failed', result: null });
    journal.append({ kind: 'phase', nodeId: 'work', attempt: 1, status: 'failed', result: null });
    journal.append({ kind: 'node_result', nodeId: 'retried', attempt: 1, status: 'failed', result: null });
    journal.append({ kind: 'node_result', nodeId: 'retried', attempt: 2, reqHash: 'retried-key', status: 'succeeded', result: 'recovered' });

    expect(journal.pruneTrailingFailures()).toBe(3);
    expect(journal.all().map((record) => record.nodeId)).toEqual(['work', 'steady', 'retried', 'retried']);
    expect(journal.hit('steady', 'steady-key')?.result).toBe('kept');
    expect(journal.hit('retried', 'retried-key')?.result).toBe('recovered');
  });

  it('settles orphan running markers as non-replayable skipped records', () => {
    const journal = Journal.memory({ nowMs: () => 1 });
    journal.append({ kind: 'phase', nodeId: 'work', attempt: 1, status: 'running', result: null });
    journal.append({ kind: 'node_result', nodeId: 'done', attempt: 1, reqHash: 'done-key', status: 'succeeded', result: 7 });

    expect(journal.reconcileOrphanRunning()).toBe(1);
    expect(journal.all()[0]).toMatchObject({ status: 'skipped', errorClass: 'orphan_running' });
    expect(journal.hit('done', 'done-key')?.result).toBe(7);
  });

  it('keeps only nodes whose dependencies are complete', () => {
    const nodes = [{ id: 'root' }, { id: 'left' }, { id: 'right' }, { id: 'tail' }];
    const dependencies = new Map([
      ['root', new Set<string>()],
      ['left', new Set(['root'])],
      ['right', new Set(['root'])],
      ['tail', new Set(['left', 'right'])],
    ]);
    expect(readyNodes(nodes, dependencies, new Set())).toEqual([nodes[0]]);
    expect(readyNodes(nodes, dependencies, new Set(['root']))).toEqual([nodes[1], nodes[2]]);
  });

  it('honors a live concurrency limit without cancelling active work', async () => {
    const gate = new ConcurrencyGate(2);
    const releaseA = await gate.acquire();
    const releaseB = await gate.acquire();
    const waiting = gate.acquire();
    gate.setLimit(1);
    releaseA();
    await Promise.resolve();
    expect(gate.active).toBe(1);
    releaseB();
    const releaseC = await waiting;
    expect(gate.active).toBe(1);
    releaseC();
    expect(gate.active).toBe(0);
  });

  it('validates resume token payloads structurally', () => {
    expect(isResumeTokenPayload({ runId: 'r', nodeId: 'n', issuedAt: 1, nonce: 'x' })).toBe(true);
    expect(isResumeTokenPayload({ runId: 'r', nodeId: 'n', issuedAt: Number.NaN, nonce: 'x' })).toBe(false);
  });
});
