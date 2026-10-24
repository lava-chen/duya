import { describe, expect, it } from 'vitest';
import { WorkflowEngine, computeDefinitionHash, type WorkflowHost, type WorkflowRuntimePorts } from '../src/index.js';
import { computeReqHash, Journal } from '../src/journal.js';
import { stoppedRecoveryGraph } from './fixtures/graphs.js';

function recoveryPorts(): WorkflowRuntimePorts {
  let id = 0;
  return {
    clock: { nowMs: () => 1_000, sleep: async () => {} },
    random: { next: () => 0.5 },
    ids: { newId: () => `recovery-${++id}` },
    hash: { sha256: () => 'f'.repeat(64) },
    resumeTokens: { create: ({ runId, nodeId }) => `${runId}:${nodeId}`, verify: () => null },
  };
}

describe('@duya/workflow graph recovery', () => {
  it('replays a stopped graph from successful journal facts without DB or worker services', async () => {
    const ports = recoveryPorts();
    const journal = Journal.memory({ nowMs: ports.clock.nowMs });
    const cachedReqHash = computeReqHash('node_result', { tool: 'cached-tool', input: {} }, ports.hash);
    journal.append({
      kind: 'node_result', nodeId: 'cached', attempt: 1, reqHash: cachedReqHash,
      status: 'succeeded', result: 'already-completed',
    });
    journal.append({ kind: 'node_result', nodeId: 'fresh', attempt: 1, status: 'running', result: null });

    expect(journal.reconcileOrphanRunning()).toBe(1);
    expect(journal.all().find((record) => record.errorClass === 'orphan_running'))
      .toMatchObject({ nodeId: 'fresh', status: 'skipped' });

    const calls: Array<{ tool: string; input: unknown }> = [];
    const host: WorkflowHost = {
      async runTool(tool, input) {
        calls.push({ tool, input });
        return { ok: true, output: tool === 'fresh-tool' ? 'fresh-result' : 'tail-result' };
      },
      async runAgent() { return { ok: true }; },
      async requestApproval() { return { decision: 'approve' }; },
    };
    const engine = new WorkflowEngine({ host, ports, maxConcurrency: 2 });

    const outcome = await engine.execute(stoppedRecoveryGraph, {}, {
      runId: 'recoverable-run',
      journal,
      expectedDefinitionHash: computeDefinitionHash(stoppedRecoveryGraph, ports.hash),
    });

    expect(outcome).toMatchObject({ status: 'complete', runId: 'recoverable-run' });
    expect(calls).toEqual([
      { tool: 'fresh-tool', input: {} },
      { tool: 'tail-tool', input: { value: 'fresh-result' } },
    ]);
    expect(journal.hit('cached', cachedReqHash)?.result).toBe('already-completed');
    expect(journal.all().filter((record) => record.nodeId === 'fresh').map((record) => record.status))
      .toEqual(['skipped', 'succeeded']);
  });
});
