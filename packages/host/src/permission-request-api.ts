import type {
  HostPermissionRequest,
  HostPermissionRequestApiV1,
  HostPermissionRequestCreateInput,
  HostPermissionRequestResolveInput,
} from '@duya/agent-protocol';
import type { CoreDataHostStores } from '@duya/data/core-data-host';

type StoredPermission = NonNullable<ReturnType<CoreDataHostStores['permissions']['get']>>;

function toHostPermissionRequest(permission: StoredPermission): HostPermissionRequest {
  return {
    id: permission.id,
    sessionId: permission.sessionId,
    toolName: permission.toolName,
    toolInput: permission.toolInput,
    status: permission.status,
    decision: permission.decision,
    message: permission.message,
    updatedPermissions: permission.updatedPermissions,
    updatedInput: permission.updatedInput,
    createdAt: permission.createdAt,
    resolvedAt: permission.resolvedAt,
  };
}

/** Compose the async permission-request contract over Host-owned Data stores. */
export function createHostPermissionRequestApi(
  stores: Pick<CoreDataHostStores, 'permissions'>,
): HostPermissionRequestApiV1 {
  return {
    async createPermissionRequest(input: HostPermissionRequestCreateInput) {
      const created = stores.permissions.create({
        id: input.id,
        sessionId: input.sessionId ?? null,
        toolName: input.toolName,
        toolInput: input.toolInput === undefined ? null : input.toolInput,
      });
      return toHostPermissionRequest(created);
    },

    async getPermissionRequest(id: string) {
      const permission = stores.permissions.get(id);
      return permission ? toHostPermissionRequest(permission) : null;
    },

    async listPendingPermissionRequests(sessionId) {
      return stores.permissions.listPending(sessionId).map(toHostPermissionRequest);
    },

    async resolvePermissionRequest(id: string, input: HostPermissionRequestResolveInput) {
      const permission = stores.permissions.resolve(id, {
        status: input.status,
        ...(input.decision === undefined ? {} : { decision: input.decision }),
        ...(input.message === undefined ? {} : { message: input.message }),
        ...(input.updatedPermissions === undefined ? {} : { updatedPermissions: [...input.updatedPermissions] }),
        ...(input.updatedInput === undefined ? {} : { updatedInput: { ...input.updatedInput } }),
      });
      return permission ? toHostPermissionRequest(permission) : null;
    },
  };
}
