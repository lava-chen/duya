/**
 * decide/unattended.ts — machine-side approval for unattended runs
 * (plan 552 Phase 0 / §5 落点⑥).
 *
 * Background workflow runs (cron / HTTP / bot triggers) cannot rely on
 * a renderer being present to pop an approval card. The unattended
 * confirm gate replaces the human question with an EXPLICIT machine
 * policy: only action kinds pre-authorized by the run's config are
 * auto-approved; everything else is denied (the decide loop surfaces
 * `needs_confirmation` and the workflow parks on a human node — the
 * 498 card still owns the risky decision when someone looks).
 *
 * Every decision — allow AND deny — is written to an injectable audit
 * sink so an unattended run leaves the same review trail an attended
 * approval card would. The gate never invents approvals: default is
 * deny, and an empty policy approves nothing.
 */

import type { DecideAction } from './controller.js';
import type { DecideConfirmGate } from './confirm-gate.js';

/** Machine-side allow policy for unattended execution. */
export interface UnattendedApprovalPolicy {
  /**
   * Action kinds the run may execute without a human. Deny-by-default:
   * an empty/absent list approves nothing. `type` / `set_value` here
   * means "may type caller-provided values" — the decide loop never
   * invents text (rule #1), so the policy does not need per-value rules.
   */
  allowedKinds?: readonly DecideAction['kind'][];
  /**
   * Safety budget: stop auto-approving after this many allowed actions
   * in one loop (a runaway policy degrades into a denial, not a bigger
   * blast radius). 0 / undefined = unlimited.
   */
  maxAutoApproved?: number;
}

/** One audit record — the unattended analogue of an approval card row. */
export interface UnattendedAuditRecord {
  at: string;
  action: DecideAction;
  allowed: boolean;
  /** Why: 'policy_kind' | 'budget_exhausted' | 'policy_deny'. */
  rule: 'policy_kind' | 'budget_exhausted' | 'policy_deny';
}

export interface UnattendedConfirmGateOptions {
  policy: UnattendedApprovalPolicy;
  /** Execute the action (as the executor confirm gate does). */
  execute: (action: DecideAction) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Audit sink (injectable; the Electron host wires a JSONL writer).
   * Synchronous, best-effort — audit failure never blocks execution.
   */
  audit?: (record: UnattendedAuditRecord) => void;
}

function actionPreview(action: DecideAction): Record<string, unknown> {
  const preview: Record<string, unknown> = { kind: action.kind };
  if (action.element !== undefined) preview.element = action.element;
  if (action.text !== undefined) preview.text = action.text;
  if (action.key !== undefined) preview.key = action.key;
  return preview;
}

/**
 * Build the unattended confirm gate. `confirm(action)` resolves true
 * only when the policy allows the action kind (and the safety budget
 * is not exhausted) AND the execution succeeded; false otherwise, so
 * the decide loop surfaces `needs_confirmation` and the workflow's
 * human node takes over.
 */
export function createUnattendedConfirmGate(
  options: UnattendedConfirmGateOptions,
): DecideConfirmGate {
  const allowedKinds = new Set(options.policy.allowedKinds ?? []);
  const budget = options.policy.maxAutoApproved ?? 0;
  let autoApproved = 0;

  return {
    async confirm(action) {
      let allowed = allowedKinds.has(action.kind);
      let rule: UnattendedAuditRecord['rule'] = allowed ? 'policy_kind' : 'policy_deny';
      if (allowed && budget > 0 && autoApproved >= budget) {
        allowed = false;
        rule = 'budget_exhausted';
      }
      try {
        options.audit?.({
          at: new Date().toISOString(),
          action: actionPreview(action) as unknown as DecideAction,
          allowed,
          rule,
        });
      } catch {
        // Best-effort audit — never blocks the gate.
      }
      if (!allowed) return false;
      autoApproved++;
      const exec = await options.execute(action);
      return exec.ok;
    },
  };
}
