import type { CreateRepositoryOptions } from '../sqlite-repository';

/** Approval endpoints are not exercised by Control Plane run-store fixtures. */
export const HOST_APPROVAL_API_STUBS = {
  permissionRequests: {
    createPermissionRequest: async () => { throw new Error('unexpected permission request create'); },
    getPermissionRequest: async () => null,
    listPendingPermissionRequests: async () => [],
    resolvePermissionRequest: async () => null,
  },
  toolApprovals: {
    createToolApproval: async () => { throw new Error('unexpected tool approval create'); },
    getToolApproval: async () => null,
    listToolApprovalsBySession: async () => [],
    resolveToolApproval: async () => null,
    consumeApprovedToolApproval: async () => false,
    consumeToolApprovalById: async () => null,
    upsertToolApprovalRule: async () => undefined,
    listToolApprovalRules: async () => [],
  },
} satisfies Pick<CreateRepositoryOptions, 'permissionRequests' | 'toolApprovals'>;
