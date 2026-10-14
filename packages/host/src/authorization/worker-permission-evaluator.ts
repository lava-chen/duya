export * from '@duya/agent-runtime/authorization/permissions/permissions';
import { createHasPermissionsToUseTool as createEvaluator } from '@duya/agent-runtime/authorization/permissions/permissions';
import { isSessionApproved } from '@duya/host/authorization/connector-approval-cache';
import { renderConnectorApprovalFromDescriptor } from '@duya/capabilities/AppConnectionTool/approval-message';
import { getCachedAppConnectionDescriptors } from '@duya/capabilities/AppConnectionTool';
import { getPermissionPrescreener } from '@duya/host/decisions';
import { logger } from '@duya/host/worker-logger';

/** Compatibility assembly; permission evaluation belongs to Runtime. */
export function createHasPermissionsToUseTool() {
  return createEvaluator({
    getConnectorDescriptors: getCachedAppConnectionDescriptors,
    isSessionApproved,
    renderConnectorApproval: (descriptor, input) => renderConnectorApprovalFromDescriptor(descriptor, input).message,
    getPermissionPrescreener,
    warn: (message, metadata) => logger.warn(message, metadata),
  });
}
