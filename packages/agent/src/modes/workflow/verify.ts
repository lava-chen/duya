/**
 * verify.ts — the fresh-eyes verify stage (plan 552 Phase 5; 415 §4.4
 * as amended by §2 principle 3 + §5 落点③).
 *
 * Three tiers, cheapest-first — every tier escalates to the next when
 * it cannot VERIFY (never a silent guess):
 *   0. deterministic — the run's own journal annotations: every node
 *      already carries `verified` (gui confirm effects, explicit gates)
 *      and none is unconfirmed/failed/skipped.
 *   1. decision (551) — one verify noul over a machine-computed summary
 *      (counts/metrics/statuses — code computes the state, Jev judges
 *      it). Gray band / unavailable → escalate.
 *   2. verification agent — an agent that did NOT run the work sees
 *      ONLY the results and the acceptance criteria (fresh eyes, grok
 *      "reviewers audit the process itself").
 *
 * The verdict lands as a `node_result` journal record with the
 * `verified` / `unconfirmed` annotation (one write, three uses) — the
 * synthesis (Phase 7 console) is REQUIRED to present the distinction.
 */

import type { WorkflowDef } from './schema.js';
import type { WorkflowHost } from './host.js';
import type { Journal } from './journal.js';
import { computeReqHash } from './journal.js';
import type { DecisionService } from '../../decisions/index.js';

export type VerifyTier = 'deterministic' | 'decision' | 'agent';

export interface VerifyVerdict {
  verification: 'verified' | 'unconfirmed';
  tier: VerifyTier;
  reason: string;
}

export interface VerifyOptions {
  def: WorkflowDef;
  outputs: Record<string, unknown>;
  journal: Journal;
  runId: string;
  host: WorkflowHost;
  decisionService?: DecisionService;
  /** Acceptance criteria fed to tiers 1-2 (fresh eyes see ONLY these). */
  acceptanceCriteria?: string;
  dryRun?: boolean;
}

/**
 * Machine-computed run summary — code computes everything countable
 * before any model sees the state (ZCode principle 2).
 */
export function summarizeRun(def: WorkflowDef, outputs: Record<string, unknown>): {
  totalNodes: number;
  succeeded: number;
  missing: number;
  nodeIds: string[];
} {
  const nodeIds: string[] = [];
  for (const phase of def.phases) for (const node of phase.nodes) nodeIds.push(node.id);
  const present = nodeIds.filter((id) => outputs[id] !== undefined);
  return {
    totalNodes: nodeIds.length,
    succeeded: present.length,
    missing: nodeIds.length - present.length,
    nodeIds,
  };
}

export async function runVerifyStage(options: VerifyOptions): Promise<VerifyVerdict> {
  const { def, outputs, journal, runId, host } = options;

  // ── Tier 0: deterministic — journal annotations decide instantly. ──
  const records = journal.all();
  const resultRecords = records.filter((r) => r.kind === 'node_result' && r.status === 'succeeded');
  const hasFailed = records.some((r) => r.status === 'failed' && r.kind === 'node_result');
  const hasUnconfirmed = resultRecords.some((r) => r.verification === 'unconfirmed');
  if (!hasFailed && !hasUnconfirmed && resultRecords.length > 0) {
    return land(journal, runId, {
      verification: 'verified',
      tier: 'deterministic',
      reason: `all ${resultRecords.length} executed nodes carry explicit verified annotations`,
    });
  }

  const summary = summarizeRun(def, outputs);
  const criteria = options.acceptanceCriteria ?? def.description;

  // ── Tier 1: decision over the machine-computed summary. ──
  if (options.decisionService?.available && !options.dryRun) {
    try {
      const res = await options.decisionService.ask(
        { task: def.description, summary, outputs },
        { done: options.decisionService.verifyQuestion(criteria) },
      );
      const { verdict } = options.decisionService.resolveNoul(res, 'done');
      if (verdict === 'yes') {
        return land(journal, runId, {
          verification: hasFailed ? 'unconfirmed' : 'verified',
          tier: 'decision',
          reason: `decision backend accepted the criteria (summary: ${summary.succeeded}/${summary.totalNodes} nodes)${hasFailed ? ' — capped by failed nodes' : ''}`,
        });
      }
      if (verdict === 'no') {
        return land(journal, runId, {
          verification: 'unconfirmed',
          tier: 'decision',
          reason: `decision backend rejected the criteria (summary: ${summary.succeeded}/${summary.totalNodes} nodes)`,
        });
      }
      // uncertain → escalate to the agent tier.
    } catch {
      // backend unavailable → escalate.
    }
  }

  // ── Tier 2: verification agent (fresh eyes). ──
  if (options.dryRun) {
    return land(journal, runId, {
      verification: 'unconfirmed',
      tier: 'agent',
      reason: 'dry-run: verify agent not invoked — run planned only',
    });
  }
  const reqHash = computeReqHash('node_result', {
    kind: 'verify', criteria, summary, outputs,
  });
  const hit = journal.hit('__verify__', reqHash);
  let agentOutput: unknown;
  if (hit) {
    agentOutput = hit.result;
  } else {
    const result = await host.runAgent(
      {
        agent: 'general-purpose',
        prompt:
          `You are verifying work you did NOT perform. Acceptance criteria: "${criteria}".\n` +
          `Run summary: ${JSON.stringify(summary)}.\nNode outputs: ${JSON.stringify(outputs)}.\n` +
          'Judge ONLY from the evidence above. Return JSON {"verified": boolean, "reason": string}.',
      },
      { runId, nodeId: '__verify__' },
    );
    if (!result.ok) {
      return land(journal, runId, {
        verification: 'unconfirmed',
        tier: 'agent',
        reason: `verification agent failed: ${result.error ?? 'unknown error'}`,
      });
    }
    agentOutput = result.output ?? null;
    journal.append({
      kind: 'node_result',
      nodeId: '__verify__',
      attempt: 1,
      reqHash,
      status: 'succeeded',
      result: agentOutput,
    });
  }
  const parsed = parseVerifyAgentOutput(agentOutput);
  return land(journal, runId, {
    verification: parsed.verified && !hasFailed ? 'verified' : 'unconfirmed',
    tier: 'agent',
    reason: `verification agent: ${parsed.reason ?? 'no reason given'}${hasFailed ? ' (run contains failed nodes)' : ''}`,
  });
}

function parseVerifyAgentOutput(output: unknown): { verified: boolean; reason?: string } {
  if (output && typeof output === 'object') {
    const obj = output as { verified?: unknown; reason?: unknown };
    if (typeof obj.verified === 'boolean') {
      return { verified: obj.verified, reason: typeof obj.reason === 'string' ? obj.reason : undefined };
    }
  }
  if (typeof output === 'string') {
    const json = /\{[\s\S]*\}/.exec(output);
    if (json) {
      try {
        return parseVerifyAgentOutput(JSON.parse(json[0]));
      } catch {
        // fall through
      }
    }
    return { verified: false, reason: output.slice(0, 200) };
  }
  return { verified: false, reason: 'unparseable verifier output' };
}

/** Land the verdict as a journaled record (cache + audit + SSE). */
function land(journal: Journal, runId: string, verdict: VerifyVerdict): VerifyVerdict {
  void runId;
  journal.append({
    kind: 'node_result',
    nodeId: '__verify__',
    attempt: 1,
    status: 'succeeded',
    result: { tier: verdict.tier, reason: verdict.reason },
    verification: verdict.verification,
  });
  return verdict;
}
