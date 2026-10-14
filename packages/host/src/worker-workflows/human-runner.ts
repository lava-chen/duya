/**
 * human-runner.ts — the human-in-the-loop node (plan 552 §4.2 ④ + §6.3).
 *
 * Marker semantics (grok `await_user`, E:754-773): before parking, the
 * runner writes a journal marker (`kind:'approval'`, status `waiting`,
 * null result). The resumed run hits the marker and passes — NO payload
 * is injected into the paused node. The user's decision lands as its
 * own `approval` journal record; the node completes with
 * `{ approved }` and DOWNSTREAM nodes read it (input goes to the
 * "world", never into the suspension point).
 *
 * Two timing modes (415 §1.2 前台优先):
 *   - 'await'   — foreground: block on the 498 card pipeline, honoring
 *                 the node's timeout; `timeout.on_timeout` decides
 *                 skip / fail / escalate.
 *   - 'suspend' — background: throw SuspensionSignal; the engine parks
 *                 the branch (status waiting + wait_till in the store,
 *                 Phase 4) and map siblings keep running.
 *
 * The human node is the ONLY path for irreversible side effects — the
 * engine has no auto-approve terminal-state capability (plan 552 §2
 * principle 4). Cached approvals are bound to THIS run's journal only.
 */

import type { HumanNodeSpec, WorkflowNode } from './schema.js';
import type { WorkflowHost, HostCallContext } from './host.js';
import type { Journal } from './journal.js';
import { computeReqHash } from './journal.js';
import { SuspensionSignal, classifyError, type WorkflowErrorClass } from './error-class.js';

export interface HumanNodeResult {
  status: 'succeeded' | 'skipped' | 'failed';
  output?: { approved: boolean; timedOut: boolean; escalated?: boolean };
  errorClass?: WorkflowErrorClass;
  error?: string;
}

export interface HumanRunOptions {
  node: WorkflowNode;
  human: HumanNodeSpec;
  host: WorkflowHost;
  journal: Journal;
  ctx: HostCallContext;
  approvalMode: 'await' | 'suspend';
  /** Resume token secret — tokens bind run + node identity (§6.3). */
  nowMs?: number;
}

const HOUR_MS = 3_600_000;

/**
 * Execute (or resolve from journal) one human node. Throws
 * SuspensionSignal in 'suspend' mode when the approval is not yet
 * resolved. Never auto-approves.
 */
export async function runHumanNode(options: HumanRunOptions): Promise<HumanNodeResult> {
  const { node, human, host, journal, ctx } = options;

  // 1. Resume path — an approval record for this node in THIS run's
  // journal settles the node without re-asking (marker semantics).
  const recorded = journal.approvalFor(node.id);
  if (recorded && recorded.status === 'succeeded') {
    const decision = (recorded.result as { decision?: string } | undefined)?.decision;
    if (decision === 'approve' || decision === 'deny') {
      return { status: 'succeeded', output: { approved: decision === 'approve', timedOut: false } };
    }
  }

  // 2. Suspension marker (§6.3): write BEFORE parking so a crash between
  // park and resume still shows the run's true state.
  const markerHash = computeReqHash('approval', { nodeId: node.id, prompt: human.prompt });
  const hasMarker = journal.all().some((r) => r.kind === 'approval' && r.nodeId === node.id && r.status === 'waiting');
  if (!hasMarker) {
    journal.append({
      kind: 'approval',
      nodeId: node.id,
      attempt: 1,
      reqHash: markerHash,
      status: 'waiting',
      result: null,
      nodeKind: 'human',
      action: 'approval',
    });
  }

  const waitTill = (options.nowMs ?? Date.now()) + human.timeout.hours * HOUR_MS;

  if (options.approvalMode === 'suspend') {
    throw new SuspensionSignal(node.id, waitTill, `human approval pending: ${node.id}`);
  }

  // 3. Foreground await — the host pops the 498 card and blocks.
  let escalated = false;
  let decision: 'approve' | 'deny' | 'timeout' = 'timeout';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await host.requestApproval(
        {
          nodeId: node.id,
          prompt: human.prompt,
          timeoutMs: human.timeout.hours * HOUR_MS,
        },
        ctx,
      );
      decision = res.decision;
    } catch (err) {
      decision = 'timeout';
      // Host gate failure is not an approval — treat as timeout escalation.
      void err;
    }
    if (decision !== 'timeout') break;
    if (human.timeout.on_timeout === 'escalate' && !escalated) {
      // Escalate = one re-notify + one more wait window (still human-only).
      escalated = true;
      continue;
    }
    break;
  }

  if (decision === 'timeout') {
    return applyTimeout(node.id, human, journal, markerHash, escalated);
  }

  // 4. Decision record — approve/deny lands as its own journal entry.
  journal.append({
    kind: 'approval',
    nodeId: node.id,
    attempt: escalated ? 2 : 1,
    reqHash: markerHash,
    status: 'succeeded',
    result: { decision, escalated },
    nodeKind: 'human',
    action: 'approval',
  });
  return { status: 'succeeded', output: { approved: decision === 'approve', timedOut: false, escalated } };
}

/**
 * Apply the node's timeout policy when the gate timed out (also called
 * by the Phase 4/6 wait-tracker scan for `wait_till` in the past).
 */
export function applyTimeout(
  nodeId: string,
  human: HumanNodeSpec,
  journal: Journal,
  markerHash: string,
  escalated = false,
): HumanNodeResult {
  switch (human.timeout.on_timeout) {
    case 'skip':
      journal.append({
        kind: 'approval',
        nodeId,
        attempt: escalated ? 2 : 1,
        reqHash: markerHash,
        status: 'skipped',
        result: { decision: 'timeout', onTimeout: 'skip' },
        nodeKind: 'human',
        action: 'approval',
      });
      return { status: 'skipped', output: { approved: false, timedOut: true, escalated } };
    case 'fail':
    case 'escalate':
    default:
      // escalate exhausts its re-notify window above; failing beats
      // leaking a suspended run (§12: 审批挂起泄漏防线).
      journal.append({
        kind: 'approval',
        nodeId,
        attempt: escalated ? 2 : 1,
        reqHash: markerHash,
        status: 'failed',
        result: { decision: 'timeout', onTimeout: human.timeout.on_timeout },
        errorClass: 'approval_timeout',
        nodeKind: 'human',
        action: 'approval',
      });
      return {
        status: 'failed',
        errorClass: 'approval_timeout',
        error: `approval timed out (on_timeout=${human.timeout.on_timeout})`,
        output: { approved: false, timedOut: true, escalated },
      };
  }
}

/** Classify helper for host-gate failures (approval_denied vs infra). */
export function approvalErrorClass(err: unknown): WorkflowErrorClass {
  const cls = classifyError(err);
  return cls === 'unknown' ? 'approval_denied' : cls;
}
