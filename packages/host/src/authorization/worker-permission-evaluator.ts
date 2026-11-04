export * from '@duya/agent-runtime/authorization/permissions/permissions';
import { createHasPermissionsToUseTool as createEvaluator } from '@duya/agent-runtime/authorization/permissions/permissions';
import { isSessionApproved } from '@duya/host/authorization/connector-approval-cache';
import { renderConnectorApprovalFromDescriptor } from '@duya/capabilities/AppConnectionTool/approval-message';
import { getCachedAppConnectionDescriptors } from '@duya/capabilities/AppConnectionTool';
import { getPermissionPrescreener } from '@duya/host/decisions';
import { logger } from '@duya/host/worker-logger';

/**
 * Compatibility assembly; permission evaluation belongs to Runtime.
 *
 * `sessionId` is bound here rather than at the call site because the evaluator
 * has no session dimension of its own: the port is `isSessionApproved(toolName)`,
 * and answering it from a process-wide set is exactly how a recycled worker
 * handed one session another session's connector grant. The bucket is chosen
 * once, by the session that owns this evaluator. No session id → no grants
 * (fail-closed to "ask again").
 */
export function createHasPermissionsToUseTool(sessionId?: string | undefined) {
  return createEvaluator({
    getConnectorDescriptors: getCachedAppConnectionDescriptors,
    isSessionApproved: (toolName: string) =>
      sessionId === undefined ? false : isSessionApproved(sessionId, toolName),
    renderConnectorApproval: (descriptor, input) => renderConnectorApprovalFromDescriptor(descriptor, input).message,
    getPermissionPrescreener,
    warn: (message, metadata) => logger.warn(message, metadata),
  });
}
