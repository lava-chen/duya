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
 *
 * Plan 560 adds the transport split: the session-anchored path keeps the
 * worker db bridge, while the run-anchored path (every writer lives in main)
 * must touch NO database and forward every journal record instead.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { workflowRunDbMocks, registryExecute } = vi.hoisted(() => ({
  workflowRunDbMocks: {
    create: vi.fn(),
    saveSnapshot: vi.fn(),
    appendJournal: vi.fn(),
    updateStatus: vi.fn(),
    finish: vi.fn(),
  },
  registryExecute: vi.fn(),
}));

vi.mock('../../ipc/db-client.js', () => ({
  workflowRunDb: workflowRunDbMocks,
}));

vi.mock('../../tool/builtin.js', () => ({
  createBuiltinRegistry: vi.fn(() => ({
    getAllTools: () => [],
    execute: registryExecute,
  })),
}));

vi.mock('../../tool/SubagentTool/index.js', () => ({
  getAgentDefinitions: vi.fn(() => []),
}));

import {
  launchSavedWorkflow,
  applyArgDefaults,
  findMissingRequiredArgs,
  type WorkflowArtifactDescriptor,
  type WorkflowDefinitionSnapshot,
  type WorkflowRunCreateRequest,
  type WorkflowRunnerTransport,
  type WorkflowRunTerminal,
} from '../workflow-runner.js';
import { serializeSavedWorkflow } from '../../modes/workflow/dwf/frontmatter.js';
import type { SavedWorkflowMeta } from '../../modes/workflow/dwf/contracts.js';
import type { JournalRecord } from '../../modes/workflow/journal.js';
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

// ─── run-anchored transport probe (plan 560 D3) ───

interface TransportLog {
  created: WorkflowRunCreateRequest[];
  snapshots: WorkflowDefinitionSnapshot[];
  records: JournalRecord[];
  terminals: Array<{ runId: string; outcome: WorkflowRunTerminal }>;
  emits: string[];
}

function makeRunAnchorTransport(): WorkflowRunnerTransport & { log: TransportLog } {
  const log: TransportLog = { created: [], snapshots: [], records: [], terminals: [], emits: [] };
  return {
    log,
    async createRun(input) {
      log.created.push(input);
    },
    async saveSnapshot(snapshot) {
      log.snapshots.push(snapshot);
    },
    appendJournal(runId, record) {
      log.records.push(record);
    },
    async finishRun(runId, outcome) {
      log.terminals.push({ runId, outcome });
    },
    emit(event) {
      log.emits.push(event);
    },
  };
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

/** Exercises the plan-560 additions: phases, tool digests, artifacts. */
const PHASE_SCRIPT = `
export default async function (wf) {
  wf.phase("collect");
  await wf.tool("Bash", { cmd: "git tag --list v*" });
  wf.phase("publish");
  await wf.publish("report.md", "hello", "text/markdown");
  return "ok";
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
  workflowRunDbMocks.finish.mockReset().mockResolvedValue(true);
  registryExecute.mockReset().mockResolvedValue({ result: 'ok', metadata: {} });
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
    // A launch that dies before the row exists must still land a terminal
    // write — otherwise a run-anchored row (created by main before spawn)
    // stays `active` forever.
    expect(workflowRunDbMocks.finish).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ status: 'failed' }),
    );
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

      expect(workflowRunDbMocks.finish).toHaveBeenCalledWith(
        'r3',
        expect.objectContaining({ status: 'complete' }),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('carries stage dividers + artifact names on the session digest frames', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-runner-'));
    try {
      writeSavedWorkflow(dir, 'staged', { description: 'staged' }, PHASE_SCRIPT);
      const { frames, deps } = makeDeps();
      await launchSavedWorkflow(deps, { runId: 'r9', workflowName: 'staged', projectDir: dir });

      const done = frames[frames.length - 1]!;
      expect(done.event).toBe('done');

      // The step list includes the wf.phase markers as nodeKind:'phase'
      // dividers — the run card cuts stage columns at them.
      const phaseSteps = done.run.steps?.filter((s) => s.nodeKind === 'phase') ?? [];
      expect(phaseSteps.map((s) => s.label)).toEqual(['collect', 'publish']);

      // Real steps carry their journal node kind so the card can pick icons.
      const toolStep = done.run.steps?.find((s) => s.id.endsWith('-tool:Bash'));
      expect(toolStep?.nodeKind).toBe('tool');
      expect(toolStep?.status).toBe('success');

      // wf.publish lands as an artifact chip name, not as a step.
      expect(done.run.artifacts).toEqual([{ name: 'report.md' }]);
      expect(done.run.steps?.some((s) => s.nodeKind === 'noop' && (s.label ?? '').startsWith('publish'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stamps origin=session on the legacy path so the runs tab stays truthful', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-runner-'));
    try {
      writeSavedWorkflow(dir, 'digest', HAPPY_META, HAPPY_SCRIPT);
      const { deps } = makeDeps();
      await launchSavedWorkflow(deps, { runId: 'r6', workflowName: 'digest', projectDir: dir });

      expect(workflowRunDbMocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ origin: 'session' }),
      );
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
      expect(workflowRunDbMocks.finish).toHaveBeenCalledWith(
        'r4',
        expect.objectContaining({ status: 'failed' }),
      );
      // The denial text rides `pause_message`, which only updateStatus writes.
      expect(workflowRunDbMocks.updateStatus).toHaveBeenCalledWith(
        'r4',
        'failed',
        expect.stringContaining('approval denied'),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ─── plan 560: run-anchored transport ──────────────────────────────────────

  it('run-anchored: touches no database and forwards every record through the transport', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-runner-'));
    try {
      writeSavedWorkflow(dir, 'anchored', { description: 'anchored' }, PHASE_SCRIPT);
      const transport = makeRunAnchorTransport();
      const { frames, deps } = makeDeps({
        transport,
        publishArtifact: async (name, _content, contentType): Promise<WorkflowArtifactDescriptor> => ({
          id: 'a1',
          name,
          contentType,
          bytes: 5,
          relPath: name,
        }),
      });
      await launchSavedWorkflow(deps, { runId: 'r5', workflowName: 'anchored', projectDir: dir });

      // Zero database access — main is the only writer (D3).
      expect(workflowRunDbMocks.create).not.toHaveBeenCalled();
      expect(workflowRunDbMocks.saveSnapshot).not.toHaveBeenCalled();
      expect(workflowRunDbMocks.appendJournal).not.toHaveBeenCalled();
      expect(workflowRunDbMocks.finish).not.toHaveBeenCalled();
      expect(workflowRunDbMocks.updateStatus).not.toHaveBeenCalled();

      // The anchor + the launch directory are stated explicitly.
      expect(transport.log.created).toHaveLength(1);
      expect(transport.log.created[0]).toMatchObject({
        id: 'r5',
        origin: 'library',
        projectDir: dir,
        parentSessionId: null,
        params: {},
      });
      expect(transport.log.snapshots[0]).toMatchObject({ runId: 'r5' });

      // No session frames at all — progress is the journal stream.
      expect(frames).toHaveLength(0);

      const records = transport.log.records;
      // Phases exist as a data source for the stage list (§6.2).
      expect(records.filter((r) => r.kind === 'phase').map((r) => r.action)).toEqual(['collect', 'publish']);
      // The step line has something readable to print — the journal used to
      // carry only a reqHash (§6.1).
      const toolRecord = records.find((r) => r.action === 'tool:Bash');
      expect(toolRecord?.inputSummary).toBe('git tag --list v*');
      expect(toolRecord?.replayed).toBeUndefined();
      expect(records.find((r) => r.kind === 'artifact')?.inputSummary).toBe('report.md');

      // Terminal carries the artifact reference so the run card can render it.
      expect(transport.log.terminals).toHaveLength(1);
      expect(transport.log.terminals[0]!.runId).toBe('r5');
      expect(transport.log.terminals[0]!.outcome).toMatchObject({ status: 'complete' });
      expect(transport.log.terminals[0]!.outcome.artifacts).toEqual([
        { id: 'a1', name: 'report.md', contentType: 'text/markdown', bytes: 5, relPath: 'report.md' },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('run-anchored: a launch failure still writes a terminal status', async () => {
    const transport = makeRunAnchorTransport();
    const { deps } = makeDeps({ transport });
    await launchSavedWorkflow(deps, { runId: 'r7', workflowName: 'ghost', projectDir: os.tmpdir() });

    expect(transport.log.terminals).toHaveLength(1);
    expect(transport.log.terminals[0]!.outcome).toMatchObject({ status: 'failed' });
    expect(transport.log.terminals[0]!.outcome.message).toContain('not found');
  });

  it('binds the launch directory as the tool working directory (§7.5)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-runner-'));
    try {
      writeSavedWorkflow(
        dir,
        'cwd-probe',
        { description: 'cwd probe' },
        `
export default async function (wf) {
  await wf.tool("Bash", { cmd: "echo hi" });
  return "ok";
}
`,
      );
      const transport = makeRunAnchorTransport();
      const { deps } = makeDeps({ transport, workingDirectory: os.tmpdir() });
      await launchSavedWorkflow(deps, { runId: 'r8', workflowName: 'cwd-probe', projectDir: dir });

      // The dialog's directory wins over the worker's default — this is what
      // gives agent nodes their working directory.
      expect(registryExecute).toHaveBeenCalledWith(
        'Bash',
        { cmd: 'echo hi' },
        dir,
        expect.objectContaining({
          options: expect.objectContaining({ workingDirectory: dir }),
        }),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
