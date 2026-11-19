/**
 * Port contract for the project tool.
 *
 * The Coordinator runs on the shared Session runtime, but its project view is
 * owned by the Host. The capability therefore describes only what the model
 * asks for; the Host resolves the caller's project from the trusted session
 * identity and returns the durable rows.
 *
 * The tool is read-only by contract: the Coordinator reads Tasks and Activity,
 * and the Host (with the user) owns every durable write.
 */

export type ProjectToolAction = 'get';

export interface ProjectToolSource {
  readonly type: string;
  readonly id: string;
}

export interface ProjectToolTask {
  readonly taskId: string;
  readonly subject: string;
  readonly description: string;
  readonly status: string;
  readonly acceptanceStatus: 'pending' | 'accepted' | 'rejected';
  readonly workSessionId: string | null;
  readonly updatedAt: number;
  readonly recordAvailable: boolean;
}

export interface ProjectToolActivity {
  readonly cursor: number;
  readonly type: string;
  readonly taskId: string | null;
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly source: ProjectToolSource;
  readonly payload: Record<string, unknown>;
  readonly createdAt: number;
}

export interface ProjectToolSnapshot {
  readonly tasks: readonly ProjectToolTask[];
  readonly activity: readonly ProjectToolActivity[];
  readonly nextCursor: number;
}

export interface ProjectToolPayload {
  readonly snapshot?: ProjectToolSnapshot;
}

export type ProjectToolOperation<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly reason: string };

export interface ProjectToolPort {
  dispatch(input: {
    readonly action: ProjectToolAction;
    readonly payload: Record<string, unknown>;
  }): Promise<ProjectToolOperation<ProjectToolPayload>>;
}
