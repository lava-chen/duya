// toolInvokePermission.ts — the `tool_invoke` ↔ permission-chain adapter
// (plan 583, ISS-04).
//
// Why this is a separate module: the mapping is security-relevant, and
// DuyaAgent.ts is far too large to unit-test a wiring detail inside
// `streamChat`. Extracting it keeps the invariant ("a meta-tool invocation
// is judged by the same assembled chain as a direct call, and anything
// unrecognised fails closed") pinned by a test instead of by a comment.
//
// The regression this exists to prevent: the `tool_invoke` dispatcher used
// to be wired to the raw `hasPermissionsToUseTool` engine, skipping the
// per-turn approval ledger, the standing `alwaysAllowTools` grants, and the
// plan-mode `gateWriteTool` write barrier — so any tool reachable through
// the meta tool bypassed the plan-mode write barrier.

import type { ToolInvokePermissionDecision } from '../tool/ToolInvokeTool/dispatcherFromRegistry.js';
import type { CanUseToolDecision } from '../tool/StreamingToolExecutor.js';

/**
 * Normalise a `CanUseToolFn` result into the dispatcher's decision shape.
 *
 * `CanUseToolFn` is typed `Promise<boolean | CanUseToolDecision>`, and
 * `CanUseToolDecision.behavior` is itself optional, so three shapes have to
 * be handled. Every ambiguous case resolves to `deny`: an unrecognised shape
 * must never widen access, and the direct-tool path already fails closed
 * (see `buildPermissions` in PermissionsGate.ts).
 */
export function normalizeCanUseToolDecision(
  decision: boolean | CanUseToolDecision,
): ToolInvokePermissionDecision {
  if (typeof decision === 'boolean') {
    return { behavior: decision ? 'allow' : 'deny' };
  }
  const behavior = decision.behavior ?? 'deny';
  return {
    behavior,
    ...(decision.message ? { message: decision.message } : {}),
  };
}
