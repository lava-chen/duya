/**
 * workflow-runner.test.ts — production dwf executor wiring (ZCode parity).
 *
 * Covers the launch pipeline with the heavy host ports mocked out
 * (builtin registry / agent definitions) but the REAL dwf compile+vm
 * execution, real journal discipline and the real SSE frame contract:
 *   - happy path: not_found / missing-args launch failures emit an error
 *     frame BEFORE any run row exists;
 *   - happy path: resolve → run row + snapshot seed → start → progress
 *     per journal record → done, journal persisted record-by-record;
 *   - approval deny lands the run failed (DwfApprovalDeniedError).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { workflowRunDbMocks } = vi.hoisted(() => ({
  workflowRunDbMocks: {
    create: vi.fn(),
    saveSnapshot: vi.fn(),
    appendJournal: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

vi.mock('../../ipc/db-client.js', () => ({
  workflowRunDb: workflowRunDbMocks,
}));

vi.mock('../../tool/builtin.js', () => ({
  createBuiltinRegistry: vi.fn(() => ({
    getAllTools: () => [],
    execute: vi.fn(async () => null),
  })),
}));

vi.mock('../../tool/SubagentTool/index.js', () => ({
  getAgentDefinitions: vi.fn(() => []),
}));

import { launchSavedWorkflow, applyArgDefaults, findMissingRequiredArgs } from '../workflow-runner.js';
import { serializeSavedWorkflow } from '../../modes/workflow/dwf/frontmatter.js';
import type { SavedWorkflowMeta } from '../../modes/workflow/dwf/contracts.js';
import type { WorkflowRunSse } from '../worker-protocol.js';

type Frame = { type: string; sessionId: string; event: string; run: WorkflowRunSse };

function makeDeps(overrides?: Partial<Parameters<typeof launchSavedWorkflow>[0]>) {
  const frames: Frame[] = [];
  const deps = {
    sessionId: 'sess-1',
    emit: (msg: unknown) => frames.push(msg as Frame),
    requestPermission: vi.fn(async () => 'allow' as const),
    llm: { apiKey: 'k', provider: 'openai' as const, model: 'm' },
    workingDirectory: process.cwd(),
    ...overrides,
  };
  return { frames, deps };
}

const HAPPY_META: SavedWorkflowMeta = {
  description: 'Test digest workflow',
  args: {
    count: { type: 'number', required: true, default: 3 },
    label: { type: 'string', default: 'x' },
  },
};

const HAPPY_SCRIPT = `
export default async function (wf) {
  await wf.log("started " + String(args.label));
  const ok = await wf.approve("proceed?", { onTimeout: "skip" });
  await wf.publish("report", { ok, count: args.count });
  return "done";
}
`;

function writeSavedWorkflow(dir: string, name: string, meta: SavedWorkflowMeta, script: string): string {
  const scopeDir = path.join(dir, '.duya', 'workflows');
  fs.mkdirSync(scopeDir, { recursive: true });
  const file = path.join(scopeDir, `${name}.dwf.ts`);
  fs.writeFileSync(file, serializeSavedWorkflow(meta, script), 'utf8');
  return file;
}

beforeEach(() => {
  workflowRunDbMocks.create.mockReset().mockImplementation(async (input: { id?: string }) => ({
    id: input.id ?? 'row',
    workflowName: 'x',
    workflowVersionId: null,
    status: 'active',
    triggerKind: 'manual',
    dedupKey: null,
    params: {},
    waitTill: null,
    retryOf: null,
    pauseMessage: null,
    createdAt: 1,
    updatedAt: 1,
  }));
  workflowRunDbMocks.saveSnapshot.mockReset().mockResolvedValue(true);
  workflowRunDbMocks.appendJournal.mockReset().mockResolvedValue(true);
  workflowRunDbMocks.updateStatus.mockReset().mockResolvedValue(true);
});

describe('arg defaults helpers', () => {
  it('applies declared defaults to absent params only', () => {
    const args = applyArgDefaults(
      { a: { type: 'string', default: 'd' }, b: { type: 'number' } },
      { b: 7 },
    );
    expect(args).toEqual({ a: 'd', b: 7 });
  });

  it('flags missing required args', () => {
    const missing = findMissingRequiredArgs(
      { a: { type: 'string', required: true, default: undefined } },
      { b: 1 },
    );
    expect(missing).toEqual(['a']);
  });
});

describe('launchSavedWorkflow', () => {
  it('fails before creating a run row when the workflow does not resolve', async () => {
    const { frames, deps } = makeDeps();
    await launchSavedWorkflow(deps, { runId: 'r1', workflowName: 'ghost', projectDir: os.tmpdir() });

    expect(frames).toHaveLength(1);
    expect(frames[0]!.event).toBe('error');
    expect(frames[0]!.run.status).toBe('failed');
    expect(frames[0]!.run.error).toContain('not found');
    expect(workflowRunDbMocks.create).not.toHaveBeenCalled();
  });

  it('fails before creating a run row when a required arg is missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-runner-'));
    try {
      writeSavedWorkflow(
        dir,
        'strict',
        { description: 'strict', args: { count: { type: 'number', required: true } } },
        'export default async function () { return 1; }\n',
      );
      const { frames, deps } = makeDeps();
      await launchSavedWorkflow(deps, { runId: 'r2', workflowName: 'strict', projectDir: dir });

      expect(frames[0]!.event).toBe('error');
      expect(frames[0]!.run.error).toContain('missing required args: count');
      expect(workflowRunDbMocks.create).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs the script end-to-end: run row, journal, frames, terminal status', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-runner-'));
    try {
      writeSavedWorkflow(dir, 'digest', HAPPY_META, HAPPY_SCRIPT);
      const { frames, deps } = makeDeps();
      await launchSavedWorkflow(deps, { runId: 'r3', workflowName: 'digest', projectDir: dir });

      // Run row created with merged arg defaults and the caller's runId.
      expect(workflowRunDbMocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'r3',
          workflowName: 'digest',
          status: 'active',
          triggerKind: 'manual',
          params: { count: 3, label: 'x' },
        }),
      );
      expect(workflowRunDbMocks.saveSnapshot).toHaveBeenCalled();

      // Journal persisted record-by-record (log + approval + artifact ≥ 3).
      expect(workflowRunDbMocks.appendJournal.mock.calls.length).toBeGreaterThanOrEqual(3);

      // Frame contract: start → progress* → done, all on the anchor session.
      const events = frames.map((f) => f.event);
      expect(events[0]).toBe('start');
      expect(events).toContain('progress');
      expect(events[events.length - 1]).toBe('done');
      for (const f of frames) {
        expect(f.type).toBe('chat:workflow_run');
        expect(f.sessionId).toBe('sess-1');
        expect(f.run.runId).toBe('r3');
      }
      expect(frames[frames.length - 1]!.run.status).toBe('complete');

      expect(workflowRunDbMocks.updateStatus).toHaveBeenCalledWith('r3', 'complete');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an approval deny lands the run failed with the denial surfaced', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-runner-'));
    try {
      writeSavedWorkflow(
        dir,
        'gated',
        { description: 'gated' },
        `
export default async function (wf) {
  await wf.approve("may I?", { onTimeout: "fail" });
  return "never";
}
`,
      );
      const { frames, deps } = makeDeps({
        requestPermission: vi.fn(async () => 'deny' as const),
      });
      await launchSavedWorkflow(deps, { runId: 'r4', workflowName: 'gated', projectDir: dir });

      const last = frames[frames.length - 1]!;
      expect(last.event).toBe('error');
      expect(last.run.status).toBe('failed');
      expect(last.run.error).toContain('approval denied');
      expect(workflowRunDbMocks.updateStatus).toHaveBeenCalledWith('r4', 'failed', expect.anything());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
