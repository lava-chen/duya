/**
 * The workflow run domain of the standalone Host's worker db bridge.
 *
 * ## Why this file exists
 *
 * The workflow runner creates a run, drives it, journals it and finishes it
 * from the worker. On the standalone Host every one of those writes used to
 * fail with `unimplemented_domain`, so the whole workflow feature died at
 * its first write — and died quietly, because a failed db request is logged
 * and the worker keeps going.
 *
 * These assertions drive the real Host-owned workflow run store, so they
 * prove the payload the bridge assembles is a payload the store accepts:
 *  - a created run carries the fields the bridge mapped, including the
 *    explicit `origin` anchor (plan 560);
 *  - a journal record survives the round trip;
 *  - a snapshot survives the round trip;
 *  - the terminal write moves the run to its finished state.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CoreDataHost } from '@duya/data/core-data-host';
import type { MainDatabase } from '@duya/data/main-database';
import type { MainSettingsStore } from '@duya/data/main-settings-store';
import type { SessionStore } from '@duya/data/session-store';
import type { RunRepository } from '../src/repository-port.js';
import { createHostWorkerDbBridge, WorkerDbBridgeError } from '../src/worker-db-bridge.js';
import { createHostWorkflowRunApi } from '../src/workflow-run-api.js';

function createCore(root: string): CoreDataHost {
  return new CoreDataHost({
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
}

function bridge(workflowRunApi?: ReturnType<typeof createHostWorkflowRunApi>) {
  return createHostWorkerDbBridge({
    runs: {} as RunRepository,
    sessions: {} as SessionStore,
    settings: {} as MainSettingsStore,
    mainDatabase: { db: {} } as MainDatabase,
    ...(workflowRunApi === undefined ? {} : { workflowRunApi }),
  });
}

describe('the standalone Host workflow run domain', () => {
  it('creates a run and keeps the fields the bridge mapped', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-host-workflow-'));
    const core = createCore(root);
    try {
      const host = bridge(createHostWorkflowRunApi(core.stores));

      const run = await host.dispatch('workflowRun:create', {
        id: 'run-1',
        workflowName: 'nightly-review',
        // Plan 560: the session-anchored runner sends the origin explicitly.
        origin: 'session',
        scope: 'project',
        projectDir: '/tmp/project',
        parentSessionId: 'session-1',
        agentModel: 'test-model',
        params: { depth: 2 },
      }) as Record<string, unknown>;

      expect(run).toMatchObject({
        id: 'run-1',
        workflowName: 'nightly-review',
        origin: 'session',
        scope: 'project',
        projectDir: '/tmp/project',
        parentSessionId: 'session-1',
        agentModel: 'test-model',
      });
      expect(run.params).toEqual({ depth: 2 });
    } finally {
      core.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('journals a record and reads it back', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-host-workflow-'));
    const core = createCore(root);
    try {
      const host = bridge(createHostWorkflowRunApi(core.stores));
      await host.dispatch('workflowRun:create', { id: 'run-1', workflowName: 'nightly-review' });

      await host.dispatch('workflowRun:appendJournal', {
        runId: 'run-1',
        record: { nodeId: 'node-a', kind: 'node_started', at: 1234 },
      });

      const journal = await host.dispatch('workflowRun:loadJournal', { runId: 'run-1' }) as unknown[];
      expect(Array.isArray(journal)).toBe(true);
      expect(journal.length).toBeGreaterThan(0);
    } finally {
      core.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('saves a snapshot and reads it back', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-host-workflow-'));
    const core = createCore(root);
    try {
      const host = bridge(createHostWorkflowRunApi(core.stores));
      await host.dispatch('workflowRun:create', { id: 'run-1', workflowName: 'nightly-review' });

      await host.dispatch('workflowRun:saveSnapshot', {
        runId: 'run-1',
        definition: { nodes: ['node-a'] },
        nodeStack: [{ nodeId: 'node-a', status: 'running' }],
        journal: [],
      });

      const snapshot = await host.dispatch('workflowRun:loadSnapshot', { runId: 'run-1' }) as Record<string, unknown>;
      expect(snapshot).toMatchObject({ runId: 'run-1' });
    } finally {
      core.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('updates the status and finishes the run', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-host-workflow-'));
    const core = createCore(root);
    try {
      const host = bridge(createHostWorkflowRunApi(core.stores));
      await host.dispatch('workflowRun:create', { id: 'run-1', workflowName: 'nightly-review' });

      await host.dispatch('workflowRun:updateStatus', {
        id: 'run-1',
        status: 'running',
        pauseMessage: 'waiting for the owner',
      });
      await host.dispatch('workflowRun:finish', {
        id: 'run-1',
        status: 'completed',
        summary: 'the owner answered',
        spentTokens: 42,
      });

      // The bridge serves the writes the workflow runner performs; the read
      // side is the Host's own store, so the assertion reads it there.
      const run = await core.stores.workflowRuns.getRun('run-1');
      expect(run).toMatchObject({ id: 'run-1', status: 'completed', summary: 'the owner answered' });
    } finally {
      core.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails fast when the Host has not composed the workflow run API', async () => {
    await expect(bridge().dispatch('workflowRun:create', { workflowName: 'nightly-review' }))
      .rejects.toMatchObject<Partial<WorkerDbBridgeError>>({ code: 'unimplemented_domain' });
  });

  it('rejects a create payload without a workflow name', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-host-workflow-'));
    const core = createCore(root);
    try {
      const host = bridge(createHostWorkflowRunApi(core.stores));

      await expect(host.dispatch('workflowRun:create', { id: 'run-1' }))
        .rejects.toMatchObject<Partial<WorkerDbBridgeError>>({ code: 'invalid_payload' });
    } finally {
      core.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
