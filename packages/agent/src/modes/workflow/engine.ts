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
import { runNode } from './node-runner.js';
import { runMapNode } from './map-runner.js';
import { applyTimeout } from './human-runner.js';
import { SuspensionSignal } from './error-class.js';
import { nodeDependencies } from './validate.js';
import { WorkflowDecisionAdapter } from './decision-adapter.js';
import type { DecisionService } from '../../decisions/index.js';
import { createResumeToken, verifyResumeToken } from './resume-token.js';

export type EngineOutcome =
  | { status: 'complete'; runId: string; outputs: Record<string, unknown> }
  | { status: 'failed'; runId: string; nodeId: string; errorClass: string; error: string }
  | { status: 'waiting'; runId: string; nodeId: string; resumeToken: string; waitTill: number }
  | { status: 'cancelled'; runId: string };

export interface EngineOptions {
  host: WorkflowHost;
  /** 551 DecisionService (the adapter wraps it; absent → decisions fail soft). */
  decisionService?: DecisionService;
  /** Resume-token signing secret (HMAC). */
  secret?: string;
  /** Plan/validate without host calls (§10.3 dry-run baseline). */
  dryRun?: boolean;
  /** 'await' = foreground approval; 'suspend' = park the branch (§6.3). */
  approvalMode?: 'await' | 'suspend';
  agentBudget?: number;
  hostCallCap?: number;
  concurrency?: number;
  signal?: AbortSignal;
}

export interface ExecuteOptions {
  runId?: string;
  journal?: Journal;
}

interface NodeState {
  status: 'succeeded' | 'skipped' | 'failed' | 'waiting';
  output?: unknown;
  errorClass?: string;
}

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
      const state = outputs.get(path[0]);
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
        if (path[1] in out) return out[path[1]];
      }
      return NOT_FOUND;
    },
  };
}

/** Topological order of one phase's nodes (cycle-free per validate.ts). */
function topoSort(nodes: WorkflowNode[]): WorkflowNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const inPhase = new Set(byId.keys());
  const depsOf = new Map<WorkflowNode, string[]>();
  for (const node of nodes) {
    const { deps } = nodeDependencies(node);
    depsOf.set(
      node,
      [...deps].filter((d) => inPhase.has(d) && d !== 'params'),
    );
  }
  const out: WorkflowNode[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (node: WorkflowNode): void => {
    if (done.has(node.id) || visiting.has(node.id)) return;
    visiting.add(node.id);
    for (const dep of depsOf.get(node) ?? []) {
      const depNode = byId.get(dep);
      if (depNode) visit(depNode);
    }
    visiting.delete(node.id);
    done.add(node.id);
    out.push(node);
  };
  for (const node of nodes) visit(node);
  return out;
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

    const baseCtx = {
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
      const phase = def.phases[phaseIndex];
      journal.append({
        kind: 'phase',
        nodeId: phase.phase,
        attempt: 1,
        status: 'running',
        result: { index: phaseIndex },
      });

      for (const node of topoSort(phase.nodes)) {
        if (this.options.signal?.aborted) {
          return { status: 'cancelled', runId };
        }

        // Conditional edge (415 §4.3): false → skipped, never blocking.
        if (node.when) {
          try {
            if (!evaluateExpr(node.when, scope)) {
              outputs.set(node.id, { status: 'skipped' });
              journal.append({
                kind: 'node_result',
                nodeId: node.id,
                attempt: 1,
                status: 'skipped',
                result: null,
              });
              continue;
            }
          } catch (err) {
            return {
              status: 'failed',
              runId,
              nodeId: node.id,
              errorClass: 'expr_error',
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }

        const ctx = { ...baseCtx, node };
        try {
          const result = node.map ? await runMapNode(ctx, this.semaphore) : await runNode(ctx);
          outputs.set(node.id, {
            status: result.status,
            output: result.output,
            errorClass: result.errorClass,
          });
          if (result.status === 'failed') {
            return {
              status: 'failed',
              runId,
              nodeId: node.id,
              errorClass: result.errorClass ?? 'unknown',
              error: result.error ?? 'node failed',
            };
          }
        } catch (err) {
          if (err instanceof SuspensionSignal) {
            // Park THIS branch only — map siblings keep their results (§6.3).
            const waitTill = err.waitTill;
            outputs.set(node.id, { status: 'waiting' });
            const token = createResumeToken(this.options.secret ?? 'duya-workflow-dev-secret', {
              runId,
              nodeId: node.id,
              issuedAt: Date.now(),
            });
            return { status: 'waiting', runId, nodeId: node.id, resumeToken: token, waitTill };
          }
          if (err instanceof BudgetExceededError) {
            // Journal-free stop (415 §5.3) — a raised budget replays cleanly.
            return {
              status: 'failed',
              runId,
              nodeId: node.id,
              errorClass: 'budget_exceeded',
              error: err.message,
            };
          }
          return {
            status: 'failed',
            runId,
            nodeId: node.id,
            errorClass: 'unknown',
            error: err instanceof Error ? err.message : String(err),
          };
        }
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
