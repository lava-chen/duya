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

function startChild(script: string, runId = 'run-1'): Harness {
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
  workflowRunDbMocks.create.mockReset();
  workflowRunDbMocks.saveSnapshot.mockReset();
  workflowRunDbMocks.appendJournal.mockReset();
  workflowRunDbMocks.updateStatus.mockReset();
  workflowRunDbMocks.finish.mockReset();
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
    // phase → tool result → published artifact.
    const records = h.frames.filter((f) => f.type === 'workflow:run-event');
    expect(records.map((f) => f.seq)).toEqual([0, 1, 2]);
    const first = records[0] as { record: { kind: string; action: string } };
    expect(first.record.kind).toBe('phase');
    expect(first.record.action).toBe('collect');
    const toolRecord = (records[1] as { record: { kind: string; action: string; inputSummary?: string } }).record;
    expect(toolRecord.kind).toBe('node_result');
    // `inputSummary` is what lets the step row read `已执行 git tag --list v*`.
    expect(toolRecord.inputSummary).toContain('git tag --list v*');
    const artifactRecord = (records[2] as { record: { kind: string } }).record;
    expect(artifactRecord.kind).toBe('artifact');

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
    const approval = h.frames.find(
      (f) => f.type === 'workflow:run-event' && (f.record as { kind: string }).kind === 'approval',
    ) as { record: { status: string; result: unknown } };
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
});
