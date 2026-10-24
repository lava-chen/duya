/**
 * engine.ts — WorkflowEngine: phases → topologically ordered nodes →
 * journal (plan 415 §5.2 as amended by 552).
 *
 * The engine is a pure async scheduler over the journal: every host
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

import type { WorkflowDef, WorkflowNode } from './schema.js';
import { WORKFLOW_BUDGET_DEFAULTS } from './schema.js';
import type { WorkflowHost } from './host.js';
import { BudgetLedger, BudgetExceededError, Semaphore } from './host.js';
import { Journal, computeReqHash, type JournalRecord } from './journal.js';
import { NOT_FOUND, evaluateExpr, type ExprScope } from './expr.js';
import { runNode, type NodeRunContext } from './node-runner.js';
import { runMapNode } from './map-runner.js';
import { applyTimeout } from './human-runner.js';
import { SuspensionSignal } from './error-class.js';
import { nodeDependencies } from './validate.js';
import type { WorkflowDecisionPort } from './decision-port.js';
import type { WorkflowRuntimePorts } from './ports.js';
import { readyNodes } from './scheduler.js';
import { computeDefinitionHash } from './hash.js';

export type EngineOutcome =
  | { status: 'complete'; runId: string; outputs: Record<string, unknown> }
  | { status: 'failed'; runId: string; nodeId: string; errorClass: string; error: string }
  | { status: 'waiting'; runId: string; nodeId: string; resumeToken: string; waitTill: number }
  | { status: 'cancelled'; runId: string };

export interface EngineOptions {
  host: WorkflowHost;
  /** Host supplied clocks, IDs, hashes, and token crypto. */
  ports: WorkflowRuntimePorts;
  /** Decision adapter is supplied by Host; absent → decisions fail soft. */
  decisions?: WorkflowDecisionPort | undefined;
  /** Plan/validate without host calls (§10.3 dry-run baseline). */
  dryRun?: boolean | undefined;
  /** 'await' = foreground approval; 'suspend' = park the branch (§6.3). */
  approvalMode?: 'await' | 'suspend' | undefined;
  agentBudget?: number | undefined;
  hostCallCap?: number | undefined;
  /** Per-run cap. Host/provider limits are a separate shared concern. */
  maxConcurrency?: number | undefined;
  /** @deprecated Use maxConcurrency. */
  concurrency?: number | undefined;
  onObservation?: ((event: WorkflowObservationEvent) => void) | undefined;
  signal?: AbortSignal | undefined;
}

export type WorkflowObservationEvent =
  | { type: 'concurrency-changed'; runId: string; previous: number; current: number }
  | { type: 'run-stalled'; runId: string; phase: string; pendingNodeIds: string[]; settledNodeIds: string[] };

export interface ExecuteOptions {
  runId?: string;
  journal?: Journal;
  /** Hash captured beside the persisted journal; mismatches are never resumed. */
  expectedDefinitionHash?: string;
}

interface NodeState {
  status: 'succeeded' | 'skipped' | 'failed' | 'blocked' | 'waiting';
  output?: unknown;
  errorClass?: string | undefined;
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

/** Same-phase dependency map; earlier phases are already settled. */
function phaseDependencies(nodes: WorkflowNode[]): Map<string, ReadonlySet<string>> {
  const inPhase = new Set(nodes.map((node) => node.id));
  const dependencies = new Map<string, ReadonlySet<string>>();
  for (const node of nodes) {
    const { deps } = nodeDependencies(node);
    dependencies.set(node.id, new Set([...deps].filter((dependency) => inPhase.has(dependency) && dependency !== 'params')));
  }
  return dependencies;
}

function workflowDependencies(def: WorkflowDef): Map<string, ReadonlySet<string>> {
  const dependencies = new Map<string, ReadonlySet<string>>();
  for (const phase of def.phases) {
    for (const node of phase.nodes) {
      const { deps } = nodeDependencies(node);
      dependencies.set(node.id, new Set([...deps].filter((dependency) => dependency !== 'params')));
    }
  }
  return dependencies;
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
    this.semaphore = new Semaphore(options.maxConcurrency ?? options.concurrency ?? 4);
  }

  get maxConcurrency(): number {
    return this.semaphore.limit;
  }

  setMaxConcurrency(limit: number, runId: string): void {
    const previous = this.semaphore.limit;
    this.semaphore.setLimit(limit);
    if (previous !== limit) this.observe({ type: 'concurrency-changed', runId, previous, current: limit });
  }

  private observe(event: WorkflowObservationEvent): void {
    try {
      this.options.onObservation?.(event);
    } catch {
      // Observability must not affect scheduling.
    }
  }

  /** Run a workflow from scratch (or continue with a primed journal). */
  async execute(def: WorkflowDef, params: Record<string, unknown>, exec?: ExecuteOptions): Promise<EngineOutcome> {
    const runId = exec?.runId ?? this.options.ports.ids.newId();
    if (exec?.expectedDefinitionHash && computeDefinitionHash(def, this.options.ports.hash) !== exec.expectedDefinitionHash) {
      return {
        status: 'failed', runId, nodeId: 'definition', errorClass: 'definition_hash_mismatch',
        error: 'workflow definition hash does not match the journal snapshot',
      };
    }
    const journal = exec?.journal ?? Journal.memory({ nowMs: this.options.ports.clock.nowMs });
    journal.listener = (record) => this.options.host.onJournalEvent?.(record);
    const outputs = new Map<string, NodeState>();
    const scope = engineScope(params, outputs);
    const dryRun = this.options.dryRun ?? false;
    const approvalMode = this.options.approvalMode ?? 'await';
    const budget = new BudgetLedger(
      this.options.agentBudget ?? WORKFLOW_BUDGET_DEFAULTS.agentBudget,
      this.options.hostCallCap ?? WORKFLOW_BUDGET_DEFAULTS.hostCallCap,
    );
    const allDependencies = workflowDependencies(def);
    let firstFailure: Extract<EngineOutcome, { status: 'failed' }> | undefined;

    const baseCtx: Omit<NodeRunContext, 'node'> = {
      runId,
      host: this.options.host,
      journal,
      budget,
      decisions: this.options.decisions,
      ports: this.options.ports,
      signal: this.options.signal,
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

      const dependencies = phaseDependencies(phase.nodes);
      const pending = new Map(phase.nodes.map((node) => [node.id, node]));
      const settled = new Set(outputs.keys());
      const running = new Map<string, Promise<void>>();
      const phaseFailedNodeIds = new Set<string>();
      const phaseBlockedNodeIds = new Set<string>();
      let waiting: { nodeId: string; waitTill: number } | undefined;
      let runStopFailure: Extract<EngineOutcome, { status: 'failed' }> | undefined;

      while (pending.size > 0 || running.size > 0) {
        if (this.options.signal?.aborted) {
          await Promise.allSettled([...running.values()]);
          return { status: 'cancelled', runId };
        }

        const ready = readyNodes([...pending.values()], dependencies, settled);
        let progressed = false;
        for (const node of ready) {
          if (runStopFailure || this.options.signal?.aborted) break;
          pending.delete(node.id);
          progressed = true;

          const failedDependencies = [...(allDependencies.get(node.id) ?? [])].filter((dependency) => {
            const state = outputs.get(dependency);
            return state?.status === 'failed' || state?.status === 'blocked';
          });
          if (failedDependencies.length > 0) {
            outputs.set(node.id, { status: 'blocked', errorClass: 'dependency_failed' });
            settled.add(node.id);
            phaseBlockedNodeIds.add(node.id);
            journal.append({
              kind: 'node_result', nodeId: node.id, attempt: 1, status: 'skipped', result: null,
              errorClass: 'dependency_failed',
            });
            continue;
          }

          if (node.when) {
            try {
              if (!evaluateExpr(node.when, scope)) {
                outputs.set(node.id, { status: 'skipped' });
                settled.add(node.id);
                journal.append({ kind: 'node_result', nodeId: node.id, attempt: 1, status: 'skipped', result: null });
                continue;
              }
            } catch (err) {
              const error = err instanceof Error ? err.message : String(err);
              outputs.set(node.id, { status: 'failed', errorClass: 'expr_error' });
              settled.add(node.id);
              phaseFailedNodeIds.add(node.id);
              firstFailure ??= {
                status: 'failed', runId, nodeId: node.id, errorClass: 'expr_error',
                error,
              };
              journal.append({
                kind: 'node_result', nodeId: node.id, attempt: 1, status: 'failed', result: null,
                errorClass: 'expr_error',
              });
              continue;
            }
          }

          const ctx = { ...baseCtx, node };
          const task = (async (): Promise<void> => {
            try {
              const result = node.map
                ? await runMapNode(ctx, this.semaphore)
                : await this.semaphore.run(() => runNode(ctx));
              outputs.set(node.id, { status: result.status, output: result.output, errorClass: result.errorClass });
              settled.add(node.id);
              if (result.status === 'failed') {
                phaseFailedNodeIds.add(node.id);
                firstFailure ??= {
                  status: 'failed', runId, nodeId: node.id,
                  errorClass: result.errorClass ?? 'unknown', error: result.error ?? 'node failed',
                };
              }
            } catch (err) {
              if (err instanceof SuspensionSignal) {
                outputs.set(node.id, { status: 'waiting' });
                waiting ??= { nodeId: node.id, waitTill: err.waitTill };
              } else if (err instanceof BudgetExceededError) {
                runStopFailure ??= {
                  status: 'failed', runId, nodeId: node.id,
                  errorClass: 'budget_exceeded', error: err.message,
                };
              } else if (this.options.signal?.aborted) {
                // Cancellation is a run-level stop and has no failure record.
              } else {
                runStopFailure ??= {
                  status: 'failed', runId, nodeId: node.id,
                  errorClass: 'unknown', error: err instanceof Error ? err.message : String(err),
                };
              }
            } finally {
              running.delete(node.id);
            }
          })();
          running.set(node.id, task);
        }

        if (runStopFailure) {
          await Promise.allSettled([...running.values()]);
          return runStopFailure;
        }
        if (running.size > 0) {
          await Promise.race([...running.values()]);
          continue;
        }
        if (progressed) continue;
        if (waiting) {
          const token = this.options.ports.resumeTokens.create({
            runId, nodeId: waiting.nodeId, issuedAt: this.options.ports.clock.nowMs(),
          });
          return {
            status: 'waiting', runId, nodeId: waiting.nodeId, resumeToken: token, waitTill: waiting.waitTill,
          };
        }
        if (pending.size > 0) {
          const pendingNodeIds = [...pending.keys()];
          this.observe({
            type: 'run-stalled', runId, phase: phase.phase, pendingNodeIds, settledNodeIds: [...settled],
          });
          return {
            status: 'failed', runId, nodeId: pendingNodeIds[0]!, errorClass: 'scheduler_stalled',
            error: `no runnable nodes in phase ${phase.phase}: ${pendingNodeIds.join(', ')}`,
          };
        }
      }
      if (runStopFailure) return runStopFailure;
      if (waiting) {
        const token = this.options.ports.resumeTokens.create({
          runId, nodeId: waiting.nodeId, issuedAt: this.options.ports.clock.nowMs(),
        });
        return { status: 'waiting', runId, nodeId: waiting.nodeId, resumeToken: token, waitTill: waiting.waitTill };
      }
      journal.append({
        kind: 'phase',
        nodeId: phase.phase,
        attempt: 1,
        status: phaseFailedNodeIds.size > 0 || phaseBlockedNodeIds.size > 0 ? 'failed' : 'succeeded',
        result: {
          index: phaseIndex,
          ...(phaseFailedNodeIds.size > 0 ? { failedNodeIds: [...phaseFailedNodeIds] } : {}),
          ...(phaseBlockedNodeIds.size > 0 ? { blockedNodeIds: [...phaseBlockedNodeIds] } : {}),
        },
      });
    }

    const outputsOut: Record<string, unknown> = {};
    for (const [id, state] of outputs) outputsOut[id] = state.output;
    if (firstFailure) return firstFailure;
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
    const payload = this.options.ports.resumeTokens.verify(resume.token);
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
    if (exec?.expectedDefinitionHash === undefined) {
      return {
        status: 'failed', runId, nodeId: 'definition', errorClass: 'definition_hash_missing',
        error: 'resume requires the definition hash stored with its journal',
      };
    }
    if (computeDefinitionHash(def, this.options.ports.hash) !== exec.expectedDefinitionHash) {
      return {
        status: 'failed', runId, nodeId: 'definition', errorClass: 'definition_hash_mismatch',
        error: 'workflow definition hash does not match the journal snapshot',
      };
    }
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
      waitingMarker?.reqHash ?? computeReqHash('approval', { nodeId, prompt: node?.human?.prompt ?? '' }, this.options.ports.hash);

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
