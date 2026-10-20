/** Durable request records used by the legacy interactive approval surface. */
export type HostPermissionRequestStatus = 'pending' | 'allow' | 'deny' | 'timeout' | 'aborted';

export interface HostPermissionRequest {
  readonly id: string;
  readonly sessionId: string | null;
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>> | null;
  /**
   * Which interactive situation raised the request, as the worker said it
   * (`generic` / `ask_user_question` / `exit_plan_mode`).
   *
   * A producer fact, so it is stored rather than re-derived: a client that
   * only saw the tool name cannot tell an `exit_plan_mode` request from a
   * generic one, and the two ask different questions of the user.
   */
  readonly mode: string | null;
  /** When the worker raised the request. Null when it did not say. */
  readonly expiresAt: number | null;
  /** Why the request was raised, in the worker's words. */
  readonly reason: string | null;
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
  readonly mode?: string | null;
  readonly expiresAt?: number | null;
  readonly reason?: string | null;
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
