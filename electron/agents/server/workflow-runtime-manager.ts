/**
 * workflow-runtime-manager.ts — plan 560 D2/D3/D8: the run-anchored runtime.
 *
 * Why this is a new manager instead of a knob on `WorkerManager`: that class is
 * keyed by session id, drives the `SessionManager` state machine, and runs an
 * idle reaper — all of which are chat concepts a workflow run does not have.
 * Generalizing it in place would have put workflow runs through chat lifecycle
 * states they never transition. This one is keyed by `runId`, owns exactly one
 * child per run, and dies with the run.
 *
 * Responsibilities (main/broker side of plan 560 §5.3):
 *   - create the run row and the definition snapshot (D3: the child is a pure
 *     executor and never opens a database),
 *   - spawn the SAME `agent-process-entry.js` bundle the chat workers use,
 *     under `DUYA_AGENT_ROLE=workflow-runtime`,
 *   - relay child frames to the durable event stream and to SSE subscribers,
 *   - settle the terminal state on `finished`, on crash, and on cancel (D7/D8).
 *
 * Concurrency: at most `MAX_CONCURRENT` live runs; an over-limit trigger fails
 * immediately with a specific error (D8: no queue, no drip).
 */

import { fork, type ChildProcess } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { createWorkerEnvironment } from './worker-manager';
import { getWorkerMaxMemoryMB } from './worker-limits';
import type { Logger } from './logger';
import type { JournalRecord } from '../../../packages/agent/src/modes/workflow/journal';
import type { WorkflowArtifactDescriptor } from '../../../packages/agent/src/process/workflow-runner';

/** Live approval request, relayed to the run panel (plan 560 D6). */
export interface WorkflowRuntimePermissionRequest {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  expiresAt: number;
}

/** Terminal rollup carried by the `done` frame and the run row. */
export interface WorkflowRunSummary {
  runId: string;
  workflowName: string;
  status: string;
  startedAt: number;
  finishedAt: number;
  tokens?: number;
  subagents?: number;
  artifacts: WorkflowArtifactDescriptor[];
  error?: string;
}

/**
 * One SSE frame. `seq` is the journal cursor and is present on `record` frames
 * only — it is the `?afterSeq=` replay key, and non-journal frames (artifacts,
 * approvals, the terminal rollup) have no place in that ordering.
 */
export interface WorkflowRuntimeSseFrame {
  frame: 'record' | 'artifact' | 'permission' | 'done';
  runId: string;
  seq?: number;
  record?: JournalRecord;
  artifact?: WorkflowArtifactDescriptor;
  request?: WorkflowRuntimePermissionRequest;
  summary?: WorkflowRunSummary;
}

export interface WorkflowRuntimeTriggerInput {
  name: string;
  params?: Record<string, unknown>;
  /** Launch dialog directory: the run's cwd, and the agent nodes' workingDirectory. */
  projectDir?: string;
  scope?: 'project' | 'global' | null;
  /**
   * LLM config for any agent work inside the run. Resolved by the router from
   * the active provider when absent — the manager has no provider knowledge.
   */
  llm: {
    apiKey: string;
    baseURL?: string;
    provider: 'anthropic' | 'openai' | 'ollama';
    model: string;
    authStyle?: 'api_key' | 'auth_token';
  };
  /**
   * Plan 565 Phase A: seed the child's replay cache from this prior run's
   * journal. The child loads it itself over the forwarded `db:request`
   * channel (read-only — D3's "main is the only writer" is untouched).
   */
  resumeFromRunId?: string;
  /**
   * Plan 568: run-level agent model override (launch dialog). When present it
   * overrides `llm.model` for this run AND is recorded on the run row
   * (`agent_model`) so 重跑 / 续跑 reuse the same model.
   */
  model?: string;
}

export type WorkflowRuntimeTriggerResult =
  | { ok: true; runId: string }
  /** `runId` is present when the row was created and then settled as failed. */
  | { ok: false; status: number; error: string; runId?: string };

export interface WorkflowRuntimeManagerDeps {
  /** Absolute path of the agent process bundle (chat-worker parity). */
  workerPath: string;
  betterSqlite3Path: string;
  /** IPC bridge to the Electron main process (runs, events, snapshots). */
  dbRequest: (action: string, payload: Record<string, unknown>) => Promise<unknown>;
  /**
   * Shared worker→main RPC registry. The child gets a real IPC channel so its
   * `db:request` / RPC families are answered by main exactly like a worker's;
   * this path never issues one (D3), it just refuses to deadlock if it does.
   */
  workerDbRequests: Map<string, ChildProcess>;
  logger: Logger;
  httpLogger: Logger;
  maxConcurrent?: number;
  /** Artifact ROOT; defaults to `~/.duya/workflow-artifacts`. */
  artifactsRoot?: string;
  /**
   * Injection seam for tests only: defaults to `child_process.fork`. Everything
   * below it (env construction, wiring, self-resolution) stays real, so a test
   * that swaps this still exercises the production spawn path.
   */
  forkChild?: typeof fork;
}

// ─── child env / spawn ───

/** RPC families the request-scoped routes forward to main (worker parity). */
const FORWARDED_RPC_TYPES = new Set([
  'db:request',
  'conductor:executor:rpc',
  'appConnection:invoke',
  'appConnection:listDescriptors',
  'appConnection:catalog',
  'computer-use:execute',
  'memory-tier:rpc',
  'bot-identity:rpc',
]);

/** SIGTERM grace before SIGKILL (D7: the dwf sandbox has no graceful abort). */
const CANCEL_GRACE_MS = 2_000;
/** Ready-handshake ceiling, matching the lazy-spawn worker path. */
const READY_TIMEOUT_MS = 30_000;
/** Terminal entries are kept this long so a late SSE subscriber sees `done`. */
const FINISHED_RETENTION_MS = 5 * 60 * 1000;
/** Cap on the in-memory replay log; the events table is the durable copy. */
const MAX_FRAME_LOG = 2_000;

interface RunEntry {
  runId: string;
  workflowName: string;
  child: ChildProcess;
  startedAt: number;
  status: 'running' | 'finished';
  /** Set once the terminal write lands — the reported lifecycle status. */
  terminalStatus?: string;
  finishedAt?: number;
  frames: WorkflowRuntimeSseFrame[];
  subscribers: Set<(frame: WorkflowRuntimeSseFrame) => void>;
  lastSeq: number;
  artifacts: WorkflowArtifactDescriptor[];
  tokens?: number;
  subagents?: number;
  /** Serializes writes so events land in the table in production order. */
  writes: Promise<void>;
  handshake: Promise<{ ok: true } | { ok: false; error: string }>;
  settleHandshake: (value: { ok: true } | { ok: false; error: string }) => void;
  handshakeSettled: boolean;
  /** True once the child reported `ready` — a terminal before that is a launch failure. */
  ready: boolean;
  intentionalKill: boolean;
  stdoutBuffer: string;
  handshakeTimer?: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
}

export function defaultArtifactsRoot(): string {
  return join(homedir(), '.duya', 'workflow-artifacts');
}

export class WorkflowRuntimeManager {
  private readonly runs = new Map<string, RunEntry>();
  private readonly deps: WorkflowRuntimeManagerDeps;
  private readonly maxConcurrent: number;
  private readonly artifactsRoot: string;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: WorkflowRuntimeManagerDeps) {
    this.deps = deps;
    this.maxConcurrent = deps.maxConcurrent ?? 3;
    this.artifactsRoot = deps.artifactsRoot ?? defaultArtifactsRoot();
  }

  // ─── inspection ───

  get activeCount(): number {
    let n = 0;
    for (const entry of this.runs.values()) if (entry.status === 'running') n++;
    return n;
  }

  listRuns(): Array<{ runId: string; workflowName: string; status: string; startedAt: number; finishedAt?: number; pid?: number }> {
    return [...this.runs.values()].map((entry) => ({
      runId: entry.runId,
      workflowName: entry.workflowName,
      status: entry.terminalStatus ?? 'running',
      startedAt: entry.startedAt,
      ...(entry.finishedAt !== undefined ? { finishedAt: entry.finishedAt } : {}),
      ...(entry.child.pid !== undefined ? { pid: entry.child.pid } : {}),
    }));
  }

  hasRun(runId: string): boolean {
    return this.runs.has(runId);
  }

  /**
   * Replay the run's frames past `afterSeq` and then stream new ones, in one
   * synchronous step so no frame can slip between the two.
   *
   * Returns `null` when this process does not hold the run — the caller then
   * replays from the events table instead (history path, same endpoint).
   */
  attach(
    runId: string,
    afterSeq: number,
    write: (frame: WorkflowRuntimeSseFrame) => void,
  ): (() => void) | null {
    const entry = this.runs.get(runId);
    if (!entry) return null;
    const oldestSeq = entry.frames[0]?.seq;
    if (
      entry.frames.length === MAX_FRAME_LOG &&
      oldestSeq !== undefined &&
      afterSeq < oldestSeq - 1
    ) {
      // The replay log is capped, so a very old cursor cannot be served from
      // memory alone. The caller's `get-events` catch-up fills that gap — say
      // so instead of pretending the replay was complete.
      this.deps.httpLogger.warn('Workflow runtime SSE: replay log truncated', {
        runId,
        afterSeq,
        oldestSeq,
      });
    }
    for (const frame of entry.frames) {
      if (frame.seq === undefined || frame.seq > afterSeq) write(frame);
    }
    entry.subscribers.add(write);
    return () => {
      entry.subscribers.delete(write);
    };
  }

  // ─── trigger ───

  async trigger(input: WorkflowRuntimeTriggerInput): Promise<WorkflowRuntimeTriggerResult> {
    if (this.activeCount >= this.maxConcurrent) {
      return {
        ok: false,
        status: 429,
        error: `workflow runtime is at capacity (${this.activeCount}/${this.maxConcurrent} runs in flight)`,
      };
    }

    const runId = randomUUID();
    const projectDir = input.projectDir?.trim() ? input.projectDir.trim() : '';
    const startedAt = Date.now();
    // Plan 568: the launch dialog's model override wins over the router's
    // provider-resolved default for every agent node in this run.
    const llm = input.model && input.model.trim() !== '' ? { ...input.llm, model: input.model.trim() } : input.llm;

    try {
      // D3: main owns the row from the very first moment. The child only ever
      // reports frames, so a crashed child cannot leave a phantom run behind.
      await this.deps.dbRequest('workflowRun:create', {
        id: runId,
        workflowName: input.name,
        status: 'active',
        triggerKind: 'manual',
        origin: 'library',
        scope: input.scope ?? null,
        projectDir: projectDir || null,
        params: input.params ?? {},
        ...(input.model && input.model.trim() !== '' ? { agentModel: input.model.trim() } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger.error('Workflow runtime trigger: run row create failed', err as Error, { runId, workflowName: input.name });
      return { ok: false, status: 503, error: `failed to create run row: ${message}` };
    }

    let entry: RunEntry;
    try {
      entry = this.spawnRun(runId, input, projectDir, startedAt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.settle(runId, { status: 'failed', error: `failed to spawn workflow runtime: ${message}` });
      return { ok: false, status: 503, error: message, runId };
    }

    // Hand the run description to the child. A closed stdin here means the
    // child died during startup; the exit handler settles the run.
    try {
      entry.child.stdin?.write(
        JSON.stringify({
          type: 'workflow:init',
          runId,
          workflowName: input.name,
          params: input.params,
          projectDir: projectDir || undefined,
          scope: input.scope ?? null,
          llm,
          workingDirectory: projectDir || process.cwd(),
          artifactsRoot: this.artifactsRoot,
          ...(input.resumeFromRunId !== undefined
            ? { resumeFromRunId: input.resumeFromRunId }
            : {}),
        }) + '\n',
      );
    } catch (err) {
      this.deps.logger.warn('Workflow runtime: init write failed', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const outcome = await entry.handshake;
    if (!outcome.ok) {
      return { ok: false, status: 422, error: outcome.error, runId };
    }
    return { ok: true, runId };
  }

  // ─── cancel ───

  cancel(runId: string): { ok: boolean; error?: string } {
    const entry = this.runs.get(runId);
    if (!entry) {
      return { ok: false, error: 'run is not active in this process' };
    }
    if (entry.status !== 'running') {
      return { ok: true };
    }
    entry.intentionalKill = true;
    // Ask nicely first: the child aborts between journal records. Then SIGTERM
    // (D7) — there is no graceful interrupt in the dwf sandbox.
    try {
      entry.child.stdin?.write(JSON.stringify({ type: 'workflow:cancel', runId }) + '\n');
    } catch {
      // stdin already gone; the signals below are the real stop.
    }
    try {
      entry.child.kill('SIGTERM');
    } catch (err) {
      this.deps.logger.warn('Workflow runtime cancel: SIGTERM failed', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (entry.killTimer !== undefined) clearTimeout(entry.killTimer);
    entry.killTimer = setTimeout(() => {
      entry.killTimer = undefined;
      try {
        entry.child.kill('SIGKILL');
      } catch {
        // Already dead.
      }
    }, CANCEL_GRACE_MS);
    entry.killTimer.unref?.();
    return { ok: true };
  }

  // ─── approval round-trip ───

  /**
   * Relay an approval decision back to the child that asked for it (D6).
   *
   * The request travelled child → manager → SSE → run panel; this is the return
   * leg: IPC → HTTP → here → child stdin. A run that is gone is an honest
   * error — the child's own `expiresAt` timer turns a lost answer into a deny,
   * never a silent allow.
   */
  resolvePermission(
    runId: string,
    requestId: string,
    decision: 'allow' | 'deny',
    answers?: Record<string, string>,
  ): { ok: boolean; error?: string } {
    const entry = this.runs.get(runId);
    if (!entry) {
      return { ok: false, error: 'run is not active in this process' };
    }
    if (entry.status !== 'running') {
      return { ok: false, error: 'run is no longer running' };
    }
    try {
      entry.child.stdin?.write(
        JSON.stringify({
          type: 'workflow:permission-resolve',
          requestId,
          decision,
          // AskUserQuestion-shaped answers (plan 565 Phase D wf.ask).
          ...(answers && Object.keys(answers).length > 0 ? { answers } : {}),
        }) + '\n',
      );
    } catch (err) {
      return {
        ok: false,
        error: `failed to deliver approval: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return { ok: true };
  }

  killAll(): void {
    for (const entry of this.runs.values()) {
      if (entry.status !== 'running') continue;
      entry.intentionalKill = true;
      try {
        entry.child.kill('SIGKILL');
      } catch {
        // Already dead.
      }
    }
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  // ─── spawn / wiring ───

  private spawnRun(
    runId: string,
    input: WorkflowRuntimeTriggerInput,
    projectDir: string,
    startedAt: number,
  ): RunEntry {
    const { workerPath, betterSqlite3Path, workerDbRequests } = this.deps;
    const forkChild = this.deps.forkChild ?? fork;

    const child = forkChild(workerPath, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'] as unknown as ChildProcess['stdio'],
      // Reuse the chat worker env (daemon port, log dir, sqlite path, heap
      // budget) so the builtin tool registry behaves identically here, then
      // stamp the role. `SESSION_ID` is cleared: this process is not a session
      // worker, and the entry logs it as one.
      env: {
        ...createWorkerEnvironment(runId, getWorkerMaxMemoryMB(), betterSqlite3Path),
        DUYA_AGENT_ROLE: 'workflow-runtime',
        SESSION_ID: '',
        ELECTRON_RUN_AS_NODE: '1',
      },
      execPath: process.execPath,
    });

    let settleHandshake!: (value: { ok: true } | { ok: false; error: string }) => void;
    const handshake = new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
      settleHandshake = resolve;
    });

    const entry: RunEntry = {
      runId,
      workflowName: input.name,
      child,
      startedAt,
      status: 'running',
      frames: [],
      subscribers: new Set(),
      lastSeq: -1,
      artifacts: [],
      writes: Promise.resolve(),
      handshake,
      settleHandshake,
      handshakeSettled: false,
      ready: false,
      intentionalKill: false,
      stdoutBuffer: '',
    };
    this.runs.set(runId, entry);

    entry.handshakeTimer = setTimeout(() => {
      this.settleHandshake(entry, {
        ok: false,
        error: `workflow runtime ready timeout (${READY_TIMEOUT_MS}ms)`,
      });
      // A child that never reported readiness cannot be trusted to own the
      // run; kill it and let the exit handler settle the row.
      entry.intentionalKill = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // Already dead.
      }
    }, READY_TIMEOUT_MS);
    entry.handshakeTimer.unref?.();

    this.deps.httpLogger.info('Workflow runtime spawned', {
      runId,
      workflowName: input.name,
      pid: child.pid,
      projectDir: projectDir || null,
    });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (data: string) => this.onChildStdout(entry, data));

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (data: string) => {
      this.deps.httpLogger.debug('Workflow runtime stderr', {
        runId,
        preview: data.toString().substring(0, 300),
      });
    });

    // Worker parity: answer the child's RPC families by handing them to main.
    // This path issues none of them (D3) — the wiring exists so that a tool
    // reaching for the database fails as a tool error, not a deadlock.
    child.on('message', (msg: Record<string, unknown>) => {
      if (!process.send) return;
      if (msg.type === 'db:request' && typeof msg.id === 'string') {
        workerDbRequests.set(msg.id, child);
        process.send(msg);
        return;
      }
      if (typeof msg.requestId === 'string' && FORWARDED_RPC_TYPES.has(msg.type as string)) {
        workerDbRequests.set(`rpc:${msg.requestId}`, child);
        process.send(msg);
      }
    });

    child.on('error', (err) => {
      this.deps.logger.error('Workflow runtime child error', err, { runId });
    });

    child.on('exit', (code, signal) => {
      this.onChildExit(entry, code, signal);
    });

    this.ensureSweeper();
    return entry;
  }

  // ─── child → main ───

  private onChildStdout(entry: RunEntry, chunk: string): void {
    entry.stdoutBuffer += chunk;
    const lines = entry.stdoutBuffer.split('\n');
    entry.stdoutBuffer = lines.pop() ?? '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || !line.startsWith('{')) continue;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      this.onChildFrame(entry, frame);
    }
  }

  private onChildFrame(entry: RunEntry, frame: Record<string, unknown>): void {
    const type = frame.type as string;
    switch (type) {
      case 'workflow:ready': {
        entry.ready = true;
        if (entry.handshakeTimer !== undefined) {
          clearTimeout(entry.handshakeTimer);
          entry.handshakeTimer = undefined;
        }
        // D3: the child never writes a database, so this frame is where main
        // learns the frozen definition and stores it.
        this.enqueueWrite(entry, 'workflowRun:saveSnapshot', {
          runId: entry.runId,
          definition: frame.definition,
          nodeStack: [],
          journal: [],
        });
        this.settleHandshake(entry, { ok: true });
        this.deps.httpLogger.info('Workflow runtime ready', {
          runId: entry.runId,
          workflowName: entry.workflowName,
        });
        return;
      }

      case 'workflow:run-event': {
        const record = frame.record as JournalRecord | undefined;
        if (!record) return;
        if (typeof record.seq === 'number') entry.lastSeq = Math.max(entry.lastSeq, record.seq);
        this.enqueueWrite(entry, 'workflowRun:appendJournal', { runId: entry.runId, record });
        if (typeof record.usage === 'object' && record.usage !== null) {
          const usage = record.usage as { inputTokens?: number; outputTokens?: number };
          entry.tokens =
            (entry.tokens ?? 0) + (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
        }
        if (record.nodeKind === 'agent' && record.status === 'succeeded') {
          entry.subagents = (entry.subagents ?? 0) + 1;
        }
        this.publish(entry, {
          frame: 'record',
          runId: entry.runId,
          seq: typeof record.seq === 'number' ? record.seq : entry.lastSeq,
          record,
        });
        return;
      }

      case 'workflow:permission-request': {
        this.publish(entry, {
          frame: 'permission',
          runId: entry.runId,
          request: {
            requestId: frame.requestId as string,
            toolName: frame.toolName as string,
            toolInput: (frame.toolInput as Record<string, unknown>) ?? {},
            expiresAt: frame.expiresAt as number,
          },
        });
        return;
      }

      case 'workflow:publish-artifact': {
        const artifact: WorkflowArtifactDescriptor = {
          id: frame.id as string,
          name: frame.name as string,
          contentType: frame.contentType as string,
          bytes: frame.bytes as number,
          relPath: frame.relPath as string,
        };
        entry.artifacts = [...entry.artifacts.filter((a) => a.relPath !== artifact.relPath), artifact];
        this.publish(entry, { frame: 'artifact', runId: entry.runId, artifact });
        return;
      }

      case 'workflow:finished': {
        const status = (frame.status as string) ?? 'complete';
        const error = typeof frame.error === 'string' ? frame.error : undefined;
        const artifacts = Array.isArray(frame.artifacts)
          ? (frame.artifacts as WorkflowArtifactDescriptor[])
          : entry.artifacts;
        // The launch can fail before `ready` (not-found / bad args); the row
        // already exists, so it still needs a terminal write.
        if (!entry.handshakeSettled) {
          this.settleHandshake(entry, {
            ok: false,
            error: error ?? `workflow launch failed (${status})`,
          });
        }
        void this.finishEntry(entry, {
          status,
          artifacts,
          ...(error !== undefined ? { error } : {}),
        });
        return;
      }

      default:
        // Anything else is not part of the run frame contract; ignore rather
        // than guess (a worker-shaped frame on this channel is a bug upstream).
        return;
    }
  }

  private onChildExit(entry: RunEntry, code: number | null, signal: string | null): void {
    if (entry.handshakeTimer !== undefined) {
      clearTimeout(entry.handshakeTimer);
      entry.handshakeTimer = undefined;
    }
    if (entry.killTimer !== undefined) {
      clearTimeout(entry.killTimer);
      entry.killTimer = undefined;
    }

    if (entry.status === 'finished') {
      // `finished` already settled everything; the exit is just the process
      // going away.
      this.deps.httpLogger.info('Workflow runtime exited after finish', {
        runId: entry.runId,
        code,
        signal,
      });
      return;
    }

    // D8: crashed, or killed before it could report. Either way the run needs
    // a terminal state — an `active` row that no process owns is a leak.
    const cancelled = entry.intentionalKill;
    const message = cancelled
      ? 'run cancelled'
      : `workflow runtime exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'none'})`;

    if (!entry.handshakeSettled) {
      this.settleHandshake(entry, { ok: false, error: message });
    }
    this.deps.logger.warn('Workflow runtime exited without a terminal frame', {
      runId: entry.runId,
      code,
      signal,
      cancelled,
    });
    void this.finishEntry(entry, {
      status: cancelled ? 'cancelled' : 'failed',
      artifacts: entry.artifacts,
      error: message,
    });
  }

  // ─── terminal write + fan-out ───

  /**
   * The single terminal path: durable write (`finish` + `updateStatus` for the
   * failure text, because only that one writes `pause_message`), then the `done`
   * frame. Idempotent — a double call (e.g. `finished` then `exit`) returns
   * early on `status`.
   */
  private async finishEntry(
    entry: RunEntry,
    outcome: { status: string; artifacts: WorkflowArtifactDescriptor[]; error?: string },
  ): Promise<void> {
    if (entry.status === 'finished') return;
    entry.status = 'finished';
    entry.terminalStatus = outcome.status;
    const finishedAt = Date.now();
    entry.finishedAt = finishedAt;

    const summary: WorkflowRunSummary = {
      runId: entry.runId,
      workflowName: entry.workflowName,
      status: outcome.status,
      startedAt: entry.startedAt,
      finishedAt,
      ...(entry.tokens !== undefined ? { tokens: entry.tokens } : {}),
      ...(entry.subagents !== undefined ? { subagents: entry.subagents } : {}),
      artifacts: outcome.artifacts,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    };

    // Every journal record must be durable before the terminal lands, so a
    // reader that sees `complete` can already fetch the full event stream.
    await entry.writes;
    try {
      await this.settle(entry.runId, {
        status: outcome.status,
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        ...(entry.tokens !== undefined ? { spentTokens: entry.tokens } : {}),
        ...(outcome.artifacts.length > 0 ? { artifacts: outcome.artifacts } : {}),
      });
    } catch (err) {
      this.deps.logger.error('Workflow runtime terminal write failed', err as Error, {
        runId: entry.runId,
        status: outcome.status,
      });
    }

    this.publish(entry, { frame: 'done', runId: entry.runId, summary });
    this.deps.httpLogger.info('Workflow runtime finished', {
      runId: entry.runId,
      workflowName: entry.workflowName,
      status: outcome.status,
      artifacts: outcome.artifacts.length,
      tokens: entry.tokens ?? 0,
    });
  }

  /** Terminal persistence: finish (artifacts/tokens/status) then the failure text. */
  private async settle(
    runId: string,
    outcome: {
      status: string;
      error?: string;
      artifacts?: WorkflowArtifactDescriptor[];
      spentTokens?: number;
    },
  ): Promise<void> {
    await this.deps.dbRequest('workflowRun:finish', {
      id: runId,
      status: outcome.status,
      ...(outcome.artifacts !== undefined ? { artifacts: outcome.artifacts } : {}),
      ...(outcome.spentTokens !== undefined ? { spentTokens: outcome.spentTokens } : {}),
    });
    if (outcome.error !== undefined) {
      // `pause_message` is only written by updateStatus, and the run card shows
      // it as the failure reason.
      await this.deps.dbRequest('workflowRun:updateStatus', {
        id: runId,
        status: outcome.status,
        pauseMessage: outcome.error,
      });
    }
  }

  // ─── small helpers ───

  /** Fire-and-forget durable write, serialized per run to preserve event order. */
  private enqueueWrite(entry: RunEntry, action: string, payload: Record<string, unknown>): void {
    entry.writes = entry.writes
      .then(() => this.deps.dbRequest(action, payload))
      .then(() => undefined)
      .catch((err: unknown) => {
        // Evidence persistence is best-effort: a failed write must never break
        // the run, but it must be visible.
        this.deps.logger.warn('Workflow runtime event write failed', {
          runId: entry.runId,
          action,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  private publish(entry: RunEntry, frame: WorkflowRuntimeSseFrame): void {
    entry.frames.push(frame);
    if (entry.frames.length > MAX_FRAME_LOG) {
      entry.frames.splice(0, entry.frames.length - MAX_FRAME_LOG);
    }
    for (const write of entry.subscribers) {
      try {
        write(frame);
      } catch {
        // A dead response must not break the run loop; the SSE handler
        // unsubscribes on `close`.
      }
    }
  }

  private settleHandshake(
    entry: RunEntry,
    value: { ok: true } | { ok: false; error: string },
  ): void {
    if (entry.handshakeSettled) return;
    entry.handshakeSettled = true;
    entry.settleHandshake(value);
  }

  private ensureSweeper(): void {
    if (this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(() => {
      const cutoff = Date.now() - FINISHED_RETENTION_MS;
      for (const [runId, entry] of this.runs) {
        if (entry.status === 'finished' && entry.subscribers.size === 0 && (entry.finishedAt ?? 0) < cutoff) {
          this.runs.delete(runId);
        }
      }
    }, 60_000);
    this.sweepTimer.unref?.();
  }
}
