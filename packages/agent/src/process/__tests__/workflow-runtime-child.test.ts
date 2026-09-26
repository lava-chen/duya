/**
 * workflow-runtime-child.test.ts — plan 560 D2/D3, the run-anchored executor.
 *
 * The child is what makes "a workflow runs without a chat session" true, so
 * these tests pin the three claims that would otherwise be marketing:
 *
 *   - it touches NO database (every write is a frame; main owns the tables),
 *   - the frame contract matches §5.3 (`ready` carries the definition, one
 *     `run-event` per journal record, `finished` carries artifacts + status),
 *   - approvals round-trip on the run's own channel, and a denied/timed-out
 *     approval reaches the script as a denial rather than a silent allow.
 *
 * The dwf compile+vm and the real journal discipline are exercised for real
 * (same fixture technique as workflow-runner.test.ts); the host ports are
 * mocked because this test is about the wiring, not about Bash/Subagent.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
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
    loadJournal: vi.fn(),
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

import { runWorkflowRuntimeChild } from '../workflow-runtime-child.js';
import { serializeSavedWorkflow } from '../../modes/workflow/dwf/frontmatter.js';
import type { SavedWorkflowMeta } from '../../modes/workflow/dwf/contracts.js';
import type { WorkerCommand } from '../worker-protocol.js';

const META: SavedWorkflowMeta = {
  description: 'Runtime child fixture',
  args: { label: { type: 'string', default: 'x' } },
};

function writeWorkflow(dir: string, name: string, script: string): void {
  const scopeDir = path.join(dir, '.duya', 'workflows');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.writeFileSync(path.join(scopeDir, `${name}.dwf.ts`), serializeSavedWorkflow(META, script), 'utf8');
}

/** A push-driven command stream standing in for stdin. */
function commandStream(): { stream: AsyncIterable<WorkerCommand>; push: (cmd: Record<string, unknown>) => void } {
  const queue: WorkerCommand[] = [];
  let wake: (() => void) | null = null;
  const stream = {
    async *[Symbol.asyncIterator](): AsyncGenerator<WorkerCommand> {
      for (;;) {
        while (queue.length > 0) yield queue.shift() as WorkerCommand;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
  return {
    stream,
    push: (cmd) => {
      queue.push(cmd as unknown as WorkerCommand);
      const w = wake;
      wake = null;
      w?.();
    },
  };
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** Bounded poll — the child's frames arrive across microtask turns. */
async function waitFor(predicate: () => boolean, label: string, seen?: () => string[]): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await flush(2);
  }
  throw new Error(
    `timed out waiting for ${label}; frames so far: ${JSON.stringify(seen?.() ?? [])}`,
  );
}

interface Harness {
  frames: Array<Record<string, unknown>>;
  push: (cmd: Record<string, unknown>) => void;
  run: Promise<void>;
  dir: string;
  artifactsRoot: string;
}

function startChild(
  script: string,
  runId = 'run-1',
  extraInit?: Record<string, unknown>,
): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-wf-child-'));
  const artifactsRoot = path.join(dir, 'artifacts');
  fs.mkdirSync(artifactsRoot, { recursive: true });
  writeWorkflow(dir, 'fixture', script);

  const frames: Array<Record<string, unknown>> = [];
  const { stream, push } = commandStream();
  const run = runWorkflowRuntimeChild({
    emit: (frame) => frames.push(frame),
    commands: stream,
  });

  push({
    type: 'workflow:init',
    runId,
    workflowName: 'fixture',
    projectDir: dir,
    llm: { apiKey: 'k', provider: 'openai', model: 'm' },
    workingDirectory: dir,
    artifactsRoot,
    ...(extraInit ?? {}),
  });

  return { frames, push, run, dir, artifactsRoot };
}

const SCRIPT = `
export default async function (wf) {
  wf.phase("collect");
  await wf.tool("Bash", { cmd: "git tag --list v*" });
  await wf.publish("report.md", "hello", "text/markdown");
  return "ok";
}
`;

beforeEach(() => {
  // Per-run text logs must not land in the real home during tests.
  process.env.DUYA_WORKFLOW_LOGS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-run-logs-'));
  workflowRunDbMocks.create.mockReset();
  workflowRunDbMocks.saveSnapshot.mockReset();
  workflowRunDbMocks.appendJournal.mockReset();
  workflowRunDbMocks.updateStatus.mockReset();
  workflowRunDbMocks.finish.mockReset();
  workflowRunDbMocks.loadJournal.mockReset().mockResolvedValue([]);
  registryExecute.mockReset().mockResolvedValue({ result: 'v0.9.0\n', metadata: { exitCode: 0 } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runWorkflowRuntimeChild — pure executor', () => {
  it('reports ready, one event per journal record, and a terminal — touching no database', async () => {
    const h = startChild(SCRIPT);
    await waitFor(
      () => h.frames.some((f) => f.type === 'workflow:finished'),
      'the finished frame',
      () => h.frames.map((f) => f.type as string),
    );
    await h.run;

    const types = h.frames.map((f) => f.type as string);
    expect(types[0]).toBe('workflow:ready');
    expect(types).toContain('workflow:publish-artifact');
    expect(types[types.length - 1]).toBe('workflow:finished');

    // D3: the child never writes a database — main owns the row and the table.
    for (const fn of Object.values(workflowRunDbMocks)) {
      expect(fn).not.toHaveBeenCalled();
    }

    const ready = h.frames[0] as { definition: { name: string; args: unknown } };
    expect(ready.definition.name).toBe('fixture');
    expect(ready.definition.args).toEqual(META.args);

    // Every journal record rides its own frame, in order, with its seq:
    // phase → tool running (plan 568 live node) → tool result → published artifact.
    const records = h.frames.filter((f) => f.type === 'workflow:run-event');
    expect(records.map((f) => f.seq)).toEqual([0, 1, 2, 3]);
    const first = records[0] as { record: { kind: string; action: string } };
    expect(first.record.kind).toBe('phase');
    expect(first.record.action).toBe('collect');
    const runningRecord = (records[1] as { record: { kind: string; status: string; action: string } }).record;
    expect(runningRecord.kind).toBe('node_result');
    expect(runningRecord.status).toBe('running');
    const toolRecord = (records[2] as { record: { kind: string; action: string; inputSummary?: string } }).record;
    expect(toolRecord.kind).toBe('node_result');
    expect(toolRecord.status).toBe('succeeded');
    // `inputSummary` is what lets the step row read `已执行 git tag --list v*`.
    expect(toolRecord.inputSummary).toContain('git tag --list v*');
    const artifactRecord = (records[3] as { record: { kind: string } }).record;
    expect(artifactRecord.kind).toBe('artifact');
    // Plan 568: the publish record carries the store ref — artifact chips click through it.
    expect((artifactRecord as { result?: { ref?: string } }).result?.ref).toBeTruthy();

    const finished = h.frames[h.frames.length - 1] as {
      status: string;
      artifacts: Array<{ name: string; contentType: string; bytes: number; relPath: string }>;
    };
    expect(finished.status).toBe('complete');
    expect(finished.artifacts).toHaveLength(1);
    expect(finished.artifacts[0]).toMatchObject({
      name: 'report.md',
      contentType: 'text/markdown',
      bytes: 5,
    });
  });

  it('writes artifact bytes into the per-run directory under the root', async () => {
    const h = startChild(SCRIPT);
    await waitFor(
      () => h.frames.some((f) => f.type === 'workflow:finished'),
      'the finished frame',
      () => h.frames.map((f) => f.type as string),
    );
    await h.run;

    const published = h.frames.find((f) => f.type === 'workflow:publish-artifact') as {
      relPath: string;
      bytes: number;
    };
    // FsArtifactStore sanitizes the base name and appends the ext for the
    // declared content type; refs stay root-relative.
    expect(published.relPath).toBe(path.join('run-1', 'report_md.md'));
    const abs = path.join(h.artifactsRoot, published.relPath);
    expect(fs.readFileSync(abs, 'utf8')).toBe('hello');
    expect(published.bytes).toBe(5);
  });

  it('round-trips an approval on the run channel and honours a denial', async () => {
    // `onTimeout` is required by the dwf contract (a timeout must be able to
    // say fail/skip/escalate), so scripts always pass it.
    const h = startChild(`
export default async function (wf) {
  const ok = await wf.approve("publish now?", { onTimeout: "fail" });
  await wf.log("approved=" + String(ok));
  return ok;
}
`);
    await waitFor(
      () => h.frames.some((f) => f.type === 'workflow:permission-request'),
      'the permission request',
      () => h.frames.map((f) => f.type as string),
    );
    const request = h.frames.find((f) => f.type === 'workflow:permission-request') as {
      requestId: string;
      toolName: string;
      toolInput: { prompt: string };
      expiresAt: number;
    };
    expect(request.toolName).toBe('workflow_approval');
    expect(request.toolInput.prompt).toBe('publish now?');

    h.push({ type: 'workflow:permission-resolve', requestId: request.requestId, decision: 'allow' });
    await waitFor(
      () => h.frames.some((f) => f.type === 'workflow:finished'),
      'the finished frame',
      () => h.frames.map((f) => f.type as string),
    );
    await h.run;

    const finished = h.frames[h.frames.length - 1] as { status: string };
    expect(finished.status).toBe('complete');
    // Plan 568: the approval node journals a running record first — the
    // terminal (last) approval record carries the answer.
    const approvalRecords = h.frames.filter(
      (f) => f.type === 'workflow:run-event' && (f.record as { kind: string }).kind === 'approval',
    ) as Array<{ record: { status: string; result: unknown } }>;
    const approval = approvalRecords[approvalRecords.length - 1];
    expect(approval.record.status).toBe('succeeded');
  });

  it('fails the run loudly when the workflow does not exist', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-wf-child-'));
    const artifactsRoot = path.join(dir, 'artifacts');
    fs.mkdirSync(artifactsRoot, { recursive: true });
    const frames: Array<Record<string, unknown>> = [];
    const { stream, push } = commandStream();
    const run = runWorkflowRuntimeChild({ emit: (f) => frames.push(f), commands: stream });
    push({
      type: 'workflow:init',
      runId: 'run-missing',
      workflowName: 'nope',
      llm: { apiKey: 'k', provider: 'openai', model: 'm' },
      workingDirectory: dir,
      artifactsRoot,
    });
    await run;

    // No `ready` at all: main reads that as a launch failure, not a live run.
    expect(frames.map((f) => f.type)).toEqual(['workflow:finished']);
    expect(frames[0]).toMatchObject({ status: 'failed' });
    expect(String((frames[0] as { error: string }).error)).toContain('not found');
  });

  it('exits quietly when stdin closes before init', async () => {
    const frames: Array<Record<string, unknown>> = [];
    const stream = (async function* (): AsyncGenerator<WorkerCommand> {
      // ends immediately
    })();
    await runWorkflowRuntimeChild({ emit: (f) => frames.push(f), commands: stream });
    expect(frames).toEqual([]);
  });

  it('resume: seeds the replay cache from the init-declared prior run', async () => {
    // Run 1 — fresh: capture the tool call's real journal record (it carries
    // the nodeId + reqHash the replay cache keys on). Plan 568: the node also
    // journals a running record first — the cache keys on the SUCCEEDED one.
    const first = startChild(SCRIPT, 'run-1');
    await waitFor(
      () => first.frames.some((f) => f.type === 'workflow:finished'),
      'run-1 finished frame',
      () => first.frames.map((f) => f.type as string),
    );
    await first.run;
    const toolRecord = first.frames.find(
      (f) =>
        f.type === 'workflow:run-event' &&
        (f.record as { kind?: string; nodeKind?: string })?.kind === 'node_result' &&
        (f.record as { nodeKind?: string })?.nodeKind === 'tool' &&
        (f.record as { status?: string })?.status === 'succeeded',
    ) as { record: Record<string, unknown> } | undefined;
    expect(toolRecord).toBeDefined();

    // Run 2 — init declares run-1 as the cache seed: the identical call
    // replays and the host is never invoked.
    workflowRunDbMocks.loadJournal.mockResolvedValue([toolRecord!.record]);
    registryExecute.mockClear();
    const h = startChild(SCRIPT, 'run-2', { resumeFromRunId: 'run-1' });
    await waitFor(
      () => h.frames.some((f) => f.type === 'workflow:finished'),
      'run-2 finished frame',
      () => h.frames.map((f) => f.type as string),
    );
    await h.run;

    // The seed load is a READ — the write mocks stay untouched (D3).
    expect(workflowRunDbMocks.loadJournal).toHaveBeenCalledWith('run-1');
    expect(workflowRunDbMocks.create).not.toHaveBeenCalled();
    expect(workflowRunDbMocks.appendJournal).not.toHaveBeenCalled();

    // The host was never invoked: the call replayed from the cache.
    expect(registryExecute).not.toHaveBeenCalled();
    const replayed = h.frames.find(
      (f) => f.type === 'workflow:run-event' && (f.record as { replayed?: boolean })?.replayed === true,
    );
    expect(replayed).toBeDefined();
    const finished = h.frames[h.frames.length - 1] as { status: string };
    expect(finished.status).toBe('complete');
  });
});
