import { describe, expect, it } from 'vitest';
import { canonicalJson, computeDefinitionHash, computeReqHash, type WorkflowHashPort } from '../src/hash.js';
import { Journal } from '../src/journal.js';
import { ConcurrencyGate, readyNodes } from '../src/scheduler.js';
import { isResumeTokenPayload } from '../src/resume-token.js';

const digest: WorkflowHashPort = { sha256: (value) => `digest:${value}` };

describe('@duya/workflow pure contracts', () => {
  it('canonicalizes nested keys and hashes the full definition and requests', () => {
    expect(canonicalJson({ z: 1, a: { y: true, x: 2 } })).toBe('{"a":{"x":2,"y":true},"z":1}');
    expect(computeDefinitionHash({ z: 1, a: 2 }, digest)).toBe('digest:{"a":2,"z":1}');
    expect(computeReqHash('tool', { z: 1, a: 2 }, digest)).toBe('digest:tool\u0000{"a":2,"z":1}');
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
