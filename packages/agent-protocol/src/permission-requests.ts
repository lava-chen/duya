/** Durable request records used by the legacy interactive approval surface. */
export type HostPermissionRequestStatus = 'pending' | 'allow' | 'deny' | 'timeout' | 'aborted';

export interface HostPermissionRequest {
  readonly id: string;
  readonly sessionId: string | null;
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>> | null;
  readonly status: HostPermissionRequestStatus;
  readonly decision: string | null;
  readonly message: string | null;
  readonly updatedPermissions: readonly unknown[] | null;
  readonly updatedInput: Readonly<Record<string, unknown>> | null;
  readonly createdAt: number;
  readonly resolvedAt: number | null;
}

export interface HostPermissionRequestCreateInput {
  readonly id: string;
  readonly sessionId?: string | null;
  readonly toolName: string;
  readonly toolInput?: Readonly<Record<string, unknown>> | null;
}

export interface HostPermissionRequestResolveInput {
  readonly status: HostPermissionRequestStatus;
  readonly decision?: string;
  readonly message?: string;
  readonly updatedPermissions?: readonly unknown[];
  readonly updatedInput?: Readonly<Record<string, unknown>>;
}

/** Async persistence boundary for interactive permission request records. */
export interface HostPermissionRequestApiV1 {
  createPermissionRequest(input: HostPermissionRequestCreateInput): Promise<HostPermissionRequest>;
  getPermissionRequest(id: string): Promise<HostPermissionRequest | null>;
  listPendingPermissionRequests(sessionId?: string): Promise<readonly HostPermissionRequest[]>;
  resolvePermissionRequest(
    id: string,
    input: HostPermissionRequestResolveInput,
  ): Promise<HostPermissionRequest | null>;
}
