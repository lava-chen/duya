/**
 * workflow-runner.ts — minimum-viable worker-side workflow SSE bridge
 * (plan 552 §14, ZCode parity).
 *
 * The full deterministic engine (modes/workflow) is not yet production-wired
 * into the agent worker (its WorkflowHost has no production impl). To make
 * the launching session's ZCode-style card real end-to-end, this bridge emits
 * genuine `chat:workflow_run` frames over the existing worker→router→SSE
 * channel — the same one goal_updated/research_updated ride — so the renderer
 * store + card can be built and exercised. The stage sequence is synthetic;
 * the transport and the run snapshot contract are real.
 *
 * Swap-in seam: replace the internal stage walk with WorkflowManager.launch()
 * once a production WorkflowHost lands; `emit` stays the stable port.
 */

import { buildWorkflowRunEvent, type WorkflowRunEventKind, type WorkflowRunSse } from './worker-protocol.js';

export interface WorkflowRunnerDeps {
  sessionId: string;
  /** Sends one raw worker stdin/stdout JSON frame (threads into sendToMain). */
  emit: (msg: unknown) => void;
}

export interface WorkflowRunRequest {
  runId: string;
  workflowName: string;
  /** Stage labels; the run walks these in order and reports at each. */
  phases?: string[];
  /** Seed the honest numbers; omitted fields stay absent ("—" on the card). */
  tokens?: number;
  subagents?: number;
  /** Force a terminal failure after the given stage index (0-based). */
  failAt?: number;
  /** Fatal error class for the failAt terminal (default 'error'). */
  errorClass?: string;
  stoppedReason?: string;
  resumable?: boolean;
}

const DEFAULT_PHASES = ['planning', 'executing', 'verifying', 'finalizing'];

const STAGE_MS = 220;

/**
 * Run a (synthetic) workflow and emit `start` → `progress`* → `done`/`error`
 * frames. Resolves when the terminal frame has been emitted. `signal` aborts
 * between stages and emits a cancelled terminal.
 */
export async function runWorkflow(
  deps: WorkflowRunnerDeps,
  req: WorkflowRunRequest,
  signal?: AbortSignal,
): Promise<void> {
  const { sessionId, emit } = deps;
  const startedAt = Date.now();
  const phases = req.phases ?? DEFAULT_PHASES;
  const uri = (event: WorkflowRunEventKind, run: WorkflowRunSse): void => {
    emit(buildWorkflowRunEvent(sessionId, event, run));
  };

  uri('start', {
    runId: req.runId,
    workflowName: req.workflowName,
    status: 'active',
    phase: phases[0],
    startedAt,
    phases: phases.length,
    tokens: req.tokens,
    subagents: req.subagents,
  });

  for (let i = 0; i < phases.length; i++) {
    if (signal?.aborted) {
      uri('error', {
        runId: req.runId,
        workflowName: req.workflowName,
        status: 'cancelled',
        phase: phases[i],
        startedAt,
        finishedAt: Date.now(),
        phases: phases.length,
        stoppedReason: 'cancelled',
        tokens: req.tokens,
        subagents: req.subagents,
      });
      return;
    }

    const failHere = req.failAt === i;
    if (failHere) {
      uri('error', {
        runId: req.runId,
        workflowName: req.workflowName,
        status: 'failed',
        phase: phases[i],
        startedAt,
        finishedAt: Date.now(),
        phases: phases.length,
        error: req.errorClass ?? 'error',
        stoppedReason: req.stoppedReason ?? 'run failed',
        resumable: req.resumable,
        tokens: req.tokens,
        subagents: req.subagents,
      });
      return;
    }

    await sleep(STAGE_MS);
    const isLast = i === phases.length - 1;
    if (isLast) {
      uri('done', {
        runId: req.runId,
        workflowName: req.workflowName,
        status: 'complete',
        phase: phases[i],
        startedAt,
        finishedAt: Date.now(),
        phases: phases.length,
        tokens: req.tokens,
        subagents: req.subagents,
      });
    } else {
      uri('progress', {
        runId: req.runId,
        workflowName: req.workflowName,
        status: 'active',
        phase: phases[i + 1],
        startedAt,
        phases: phases.length,
        tokens: req.tokens,
        subagents: req.subagents,
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}