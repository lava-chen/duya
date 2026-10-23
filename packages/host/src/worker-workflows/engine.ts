/**
 * engine.ts — WorkflowEngine: phases → topologically ordered nodes →
 * journal (plan 415 §5.2 as amended by 552).
 *
 * The engine is a plain async function over the journal: every host
 * effect goes through WorkflowHost ports, every result-bearing event
 * lands a journal record, and cache hits by `nodeId + reqHash` make a
 * re-run replay instead of re-pay (§6.4 — "可复跑/可修正").
 *
 * Journal discipline ("one write, three uses", §2 principle 4): node
 * runners own their node_result records; the engine owns phase records
 * and when-condition skips; the journal's listener taps every record
 * out to the host's progress channel (SSE in production), so entries
 * reported as they happen survive a crashed run.
 *
 * Terminal semantics (415 §5.3 + 552 §6.4):
 *   - complete → final outputs collected,
 *   - failed → the trailing failure sentinel is pruned on the NEXT
 *     resume so the failing call truly re-executes,
 *   - waiting (human / low-confidence decision) → SuspensionSignal
 *     caught here; a signed resumeToken is issued and `wait_till`
 *     recorded — the branch parks, map siblings keep running,
 *   - budget_exceeded / cancelled → journal-free stop (replayable).
 */

import { randomUUID } from 'node:crypto';
import type { WorkflowDef, WorkflowNode } from './schema.js';
import { WORKFLOW_BUDGET_DEFAULTS } from './schema.js';
import type { WorkflowHost } from './host.js';
import { BudgetLedger, BudgetExceededError, Semaphore, defaultConcurrency } from './host.js';
import { Journal, computeReqHash, type JournalRecord } from './journal.js';
import { NOT_FOUND, evaluateExpr, type ExprScope } from './expr.js';
import { runNode, type NodeRunContext } from './node-runner.js';
import { runMapNode } from './map-runner.js';
import { applyTimeout } from './human-runner.js';
import { SuspensionSignal } from './error-class.js';
import { nodeDependencies } from './validate.js';
import { WorkflowDecisionAdapter } from './decision-adapter.js';
import type { DecisionService } from '../decisions/index.js';
import { createResumeToken, verifyResumeToken } from './resume-token.js';

export type EngineOutcome =
  | { status: 'complete'; runId: string; outputs: Record<string, unknown> }
  | { status: 'failed'; runId: string; nodeId: string; errorClass: string; error: string }
  | { status: 'waiting'; runId: string; nodeId: string; resumeToken: string; waitTill: number }
  | { status: 'cancelled'; runId: string };

export interface EngineOptions {
  host: WorkflowHost;
  /** 551 DecisionService (the adapter wraps it; absent → decisions fail soft). */
  decisionService?: DecisionService | undefined;
  /** Resume-token signing secret (HMAC). */
  secret?: string | undefined;
  /** Plan/validate without host calls (§10.3 dry-run baseline). */
  dryRun?: boolean | undefined;
  /** 'await' = foreground approval; 'suspend' = park the branch (§6.3). */
  approvalMode?: 'await' | 'suspend' | undefined;
  agentBudget?: number | undefined;
  hostCallCap?: number | undefined;
  concurrency?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface ExecuteOptions {
  runId?: string;
  journal?: Journal;
}

interface NodeState {
  status: 'succeeded' | 'skipped' | 'failed' | 'waiting';
  output?: unknown;
  errorClass?: string | undefined;
}

/** How one node of a layer ended. */
type NodeStop =
  | { kind: 'ok' }
  | { kind: 'failed'; errorClass: string; error: string }
  | { kind: 'waiting'; waitTill: number }
  | { kind: 'cancelled' };

function engineScope(params: Record<string, unknown>, outputs: Map<string, NodeState>): ExprScope {
  return {
    resolve(path) {
      if (path[0] === 'params') {
        if (path.length === 1) return params;
        return path.slice(1).reduce<unknown>(
          (cur, seg) =>
            cur && typeof cur === 'object' && seg in (cur as Record<string, unknown>)
              ? (cur as Record<string, unknown>)[seg]
              : NOT_FOUND,
          params,
        );
      }
      const nodeId = path[0];
      if (nodeId === undefined) return NOT_FOUND;
      const state = outputs.get(nodeId);
      if (!state) return NOT_FOUND;
      const shortcut = path[1];
      if (path.length === 2 && shortcut === 'output') return state.output ?? null;
      if (path.length === 2 && shortcut === 'succeeded') return state.status === 'succeeded';
      if (path.length === 2 && shortcut === 'failed') return state.status === 'failed';
      if (path.length === 2 && shortcut === 'count') return Array.isArray(state.output) ? state.output.length : 0;
      if (path.length === 2 && shortcut === 'approved') {
        const approved = (state.output as { approved?: boolean } | undefined)?.approved;
        return approved === undefined ? NOT_FOUND : approved;
      }
      // Decision answers: nodeId.<questionId> → typed value (551 Phase 4).
      if (state.status === 'succeeded' && path.length === 2 && state.output && typeof state.output === 'object') {
        const out = state.output as Record<string, unknown>;
        const key = path[1];
        if (key !== undefined && key in out) return out[key];
      }
      return NOT_FOUND;
    },
  };
}

/**
 * Layered topological order of one phase's nodes (Kahn by layers; cycles
 * are rejected by validate.ts before execution).
 *
 * Every layer holds the nodes whose in-phase dependencies all landed in
 * earlier layers — the nodes inside one layer are independent of each
 * other. That is exactly the set the scheduler may interleave. The
 * previous linear `topoSort` carried the same information as a sequence,
 * which forced the executor to run every node one after another.
 */
function topoLayers(nodes: WorkflowNode[]): WorkflowNode[][] {
  const inPhase = new Set(nodes.map((n) => n.id));
  const depsOf = new Map<string, string[]>();
  for (const node of nodes) {
    const { deps } = nodeDependencies(node);
    depsOf.set(
      node.id,
      [...deps].filter((d) => inPhase.has(d) && d !== 'params'),
    );
  }
  const layers: WorkflowNode[][] = [];
  const placed = new Set<string>();
  let pending = nodes.filter((n) => !placed.has(n.id));
  while (pending.length > 0) {
    const layer = pending.filter((node) =>
      (depsOf.get(node.id) ?? []).every((dep) => placed.has(dep)),
    );
    if (layer.length === 0) {
      // Cycle — validate.ts rejects cycles before execution; keep the
      // remaining nodes in one trailing layer instead of dropping them.
      layers.push(pending);
      break;
    }
    layers.push(layer);
    for (const node of layer) placed.add(node.id);
    pending = pending.filter((n) => !placed.has(n.id));
  }
  return layers;
}

function findNode(def: WorkflowDef, nodeId: string): WorkflowNode | undefined {
  for (const phase of def.phases) {
    for (const node of phase.nodes) {
      if (node.id === nodeId) return node;
    }
  }
  return undefined;
}

export class WorkflowEngine {
  private readonly semaphore: Semaphore;

  constructor(private readonly options: EngineOptions) {
    this.semaphore = new Semaphore(options.concurrency ?? defaultConcurrency());
  }

  private decisionsAdapter(): WorkflowDecisionAdapter | undefined {
    if (!this.options.decisionService) return undefined;
    return new WorkflowDecisionAdapter(this.options.decisionService);
  }

  /** Run a workflow from scratch (or continue with a primed journal). */
  async execute(def: WorkflowDef, params: Record<string, unknown>, exec?: ExecuteOptions): Promise<EngineOutcome> {
    const runId = exec?.runId ?? randomUUID();
    const journal = exec?.journal ?? Journal.memory();
    journal.listener = (record) => this.options.host.onJournalEvent?.(record);
    const outputs = new Map<string, NodeState>();
    const scope = engineScope(params, outputs);
    const dryRun = this.options.dryRun ?? false;
    const approvalMode = this.options.approvalMode ?? 'await';
    const budget = new BudgetLedger(
      this.options.agentBudget ?? WORKFLOW_BUDGET_DEFAULTS.agentBudget,
      this.options.hostCallCap ?? WORKFLOW_BUDGET_DEFAULTS.hostCallCap,
    );

    const baseCtx: Omit<NodeRunContext, 'node'> = {
      runId,
      host: this.options.host,
      journal,
      budget,
      decisions: this.decisionsAdapter(),
      approvalMode,
      dryRun,
      scope,
    };

    for (let phaseIndex = 0; phaseIndex < def.phases.length; phaseIndex++) {
      const phase = def.phases[phaseIndex]!;
      journal.append({
        kind: 'phase',
        nodeId: phase.phase,
        attempt: 1,
        status: 'running',
        result: { index: phaseIndex },
      });

      for (const layer of topoLayers(phase.nodes)) {
        if (this.options.signal?.aborted) {
          return { status: 'cancelled', runId };
        }
        const stop = await this.runLayer(layer, baseCtx, outputs);
        if (stop) return stop;
      }

      journal.append({
        kind: 'phase',
        nodeId: phase.phase,
        attempt: 1,
        status: 'succeeded',
        result: { index: phaseIndex },
      });
    }

    const outputsOut: Record<string, unknown> = {};
    for (const [id, state] of outputs) outputsOut[id] = state.output;
    return { status: 'complete', runId, outputs: outputsOut };
  }

  /**
   * Run one layer: every node of the layer starts together, so independent
   * siblings interleave. The layer settles completely before the next one
   * starts — a later layer may read the outputs of this one.
   */
  private async runLayer(
    layer: WorkflowNode[],
    baseCtx: Omit<NodeRunContext, 'node'>,
    outputs: Map<string, NodeState>,
  ): Promise<EngineOutcome | undefined> {
    const settled = await Promise.all(
      layer.map((node) => this.runLayerNode(node, baseCtx, outputs)),
    );
    // Layer order decides which node reports the stop (deterministic).
    for (const { node, stop } of settled) {
      if (stop.kind === 'failed') {
        return {
          status: 'failed',
          runId: baseCtx.runId,
          nodeId: node.id,
          errorClass: stop.errorClass,
          error: stop.error,
        };
      }
      if (stop.kind === 'waiting') {
        const token = createResumeToken(this.options.secret ?? 'duya-workflow-dev-secret', {
          runId: baseCtx.runId,
          nodeId: node.id,
          issuedAt: Date.now(),
        });
        return {
          status: 'waiting',
          runId: baseCtx.runId,
          nodeId: node.id,
          resumeToken: token,
          waitTill: stop.waitTill,
        };
      }
      if (stop.kind === 'cancelled') {
        return { status: 'cancelled', runId: baseCtx.runId };
      }
    }
    return undefined;
  }

  /** Run one node of a layer; the caller settles the whole layer. */
  private async runLayerNode(
    node: WorkflowNode,
    baseCtx: Omit<NodeRunContext, 'node'>,
    outputs: Map<string, NodeState>,
  ): Promise<{ node: WorkflowNode; stop: NodeStop }> {
    if (this.options.signal?.aborted) {
      return { node, stop: { kind: 'cancelled' } };
    }

    // Conditional edge (415 §4.3): false → skipped, never blocking.
    if (node.when) {
      try {
        if (!evaluateExpr(node.when, baseCtx.scope)) {
          outputs.set(node.id, { status: 'skipped' });
          baseCtx.journal.append({
            kind: 'node_result',
            nodeId: node.id,
            attempt: 1,
            status: 'skipped',
            result: null,
          });
          return { node, stop: { kind: 'ok' } };
        }
      } catch (err) {
        return {
          node,
          stop: {
            kind: 'failed',
            errorClass: 'expr_error',
            error: err instanceof Error ? err.message : String(err),
          },
        };
      }
    }

    const ctx = { ...baseCtx, node };
    try {
      // Map nodes take a semaphore slot per fan-out item (map-runner), so
      // they must NOT hold a node-level slot — the node and its items
      // would compete for the same limit and deadlock at limit 1.
      const result = node.map
        ? await runMapNode(ctx, this.semaphore)
        : await this.semaphore.run(() => runNode(ctx));
      outputs.set(node.id, {
        status: result.status,
        output: result.output,
        errorClass: result.errorClass,
      });
      if (result.status === 'failed') {
        return {
          node,
          stop: {
            kind: 'failed',
            errorClass: result.errorClass ?? 'unknown',
            error: result.error ?? 'node failed',
          },
        };
      }
      return { node, stop: { kind: 'ok' } };
    } catch (err) {
      if (err instanceof SuspensionSignal) {
        // Park THIS branch only — map siblings keep their results (§6.3).
        outputs.set(node.id, { status: 'waiting' });
        return { node, stop: { kind: 'waiting', waitTill: err.waitTill } };
      }
      if (err instanceof BudgetExceededError) {
        // Journal-free stop (415 §5.3) — a raised budget replays cleanly.
        return {
          node,
          stop: { kind: 'failed', errorClass: 'budget_exceeded', error: err.message },
        };
      }
      return {
        node,
        stop: {
          kind: 'failed',
          errorClass: 'unknown',
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  /**
   * Resume a suspended run: verify the signed token, land the approval
   * decision as its own journal record (never injected into the paused
   * node — §6.3), then re-execute; journal cache hits replay completed
   * nodes at zero cost.
   */
  async resume(
    def: WorkflowDef,
    params: Record<string, unknown>,
    journal: Journal,
    resume: { token: string; decision: 'approve' | 'deny' | 'timeout' },
    exec?: ExecuteOptions,
  ): Promise<EngineOutcome> {
    const payload = verifyResumeToken(this.options.secret ?? 'duya-workflow-dev-secret', resume.token);
    if (!payload) {
      return {
        status: 'failed',
        runId: 'unknown',
        nodeId: 'unknown',
        errorClass: 'unknown',
        error: 'invalid resume token',
      };
    }
    const runId = payload.runId;
    const nodeId = payload.nodeId;
    const node = findNode(def, nodeId);
    // The approval record must carry the SAME reqHash as the waiting
    // marker written before the park — always reuse the marker's hash
    // (the prompt may be params-interpolated; the marker is ground truth).
    const waitingMarker = journal
      .all()
      .filter((r) => r.kind === 'approval' && r.nodeId === nodeId && r.status === 'waiting')
      .pop();
    const markerHash =
      waitingMarker?.reqHash ?? computeReqHash('approval', { nodeId, prompt: node?.human?.prompt ?? '' });

    if (resume.decision === 'timeout') {
      // Wait-tracker path: apply the node's on_timeout policy.
      const human = node?.human;
      if (node && human) {
        const result = applyTimeout(nodeId, human, journal, markerHash);
        if (result.status === 'failed') {
          return {
            status: 'failed',
            runId,
            nodeId,
            errorClass: result.errorClass ?? 'approval_timeout',
            error: result.error ?? 'approval timed out',
          };
        }
      }
    } else {
      const record = journal.append({
        kind: 'approval',
        nodeId,
        attempt: 1,
        reqHash: markerHash,
        status: 'succeeded',
        result: { decision: resume.decision },
      });
      this.options.host.onJournalEvent?.(record);
    }

    return this.execute(def, params, { runId, journal });
  }
}
