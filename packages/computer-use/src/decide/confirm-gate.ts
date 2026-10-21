/**
 * decide/confirm-gate.ts — user confirmation for irreversible actions
 * (plan 551 Phase 3).
 *
 * The decide loop never fires a risky action on a probability alone
 * (rule #7: the risk noul rides the fan-out, the GATE lives in code).
 * When the loop needs a human, it calls the confirm gate, which rides
 * the EXISTING approval pipeline (approval/ + the duya approval cards
 * of plans 498/419) instead of inventing a new one.
 *
 * Contract with the controller: `confirm(action)` resolves true when
 * the user approved AND the action has been executed. This is because
 * the Electron dispatch itself pops the approval card for confirm-
 * required actions — for those hosts the gate IS the action dispatch.
 * Hosts whose executor does NOT prompt should use
 * `createBridgeConfirmGate`, which asks the bridge first.
 */

import type { ApprovalBridge, ApprovalRequest } from '../approval/index.js';
import type { DecideAction } from './controller.js';

export interface DecideConfirmGate {
  /**
   * Execute-with-confirmation. Resolves true when the action was
   * approved and executed; false when the user denied / timed out.
   */
  confirm(action: DecideAction): Promise<boolean>;
}

function actionPreview(action: DecideAction): Record<string, unknown> {
  const preview: Record<string, unknown> = { kind: action.kind };
  if (action.element !== undefined) preview.element = action.element;
  if (action.text !== undefined) preview.text = action.text;
  if (action.key !== undefined) preview.key = action.key;
  if (action.direction !== undefined) preview.direction = action.direction;
  if (action.amount !== undefined) preview.amount = action.amount;
  return preview;
}

/**
 * Gate for hosts whose action executor ALREADY prompts (the Electron
 * `computer-use:execute` pipeline pops the approval card for confirm-
 * required actions). `execute` performs the action; a user rejection
 * surfaces as a false return.
 */
export function createExecutorConfirmGate(
  execute: (action: DecideAction) => Promise<{ ok: boolean; error?: string }>,
): DecideConfirmGate {
  return {
    async confirm(action) {
      const result = await execute(action);
      if (result.ok) return true;
      // User denial / timeout is a "no"; other failures mean the action
      // did not go through for other reasons — treat as not approved so
      // the loop hands control back to the planner.
      return false;
    },
  };
}

/**
 * Gate for hosts whose executor does NOT prompt: ask the ApprovalBridge
 * first, execute only on an explicit allow.
 */
export function createBridgeConfirmGate(
  bridge: ApprovalBridge,
  execute: (action: DecideAction) => Promise<{ ok: boolean; error?: string }>,
  timeoutMs = 30_000,
): DecideConfirmGate {
  return {
    async confirm(action) {
      const req: ApprovalRequest = {
        requestId: `${action.kind}:${action.element ?? ''}:${Date.now()}`,
        action: action.kind,
        argsPreview: actionPreview(action),
        issuedAt: new Date().toISOString(),
        timeoutMs,
      };
      const result = await bridge.requestApproval(req);
      if (!result.approved) return false;
      const exec = await execute(action);
      return exec.ok;
    },
  };
}
