/**
 * Port contract for the project tool.
 *
 * The Coordinator runs on the shared Session runtime, but its project view is
 * owned by the Host. The capability therefore describes only what the model
 * asks for; the Host resolves the caller's project from the trusted session
 * identity and returns the durable rows.
 */

export type ProjectToolAction =
  | 'get'
  | 'context'
  | 'update_state'
  | 'record_decision'
  | 'record_memory';

export interface ProjectToolSource {
  readonly type: string;
  readonly id: string;
}

export interface ProjectToolProject {
  readonly projectId: string;
  readonly name: string;
  readonly coordinatorSessionId: string | null;
}

export interface ProjectToolState {
  readonly revision: number;
  readonly currentState: string;
  readonly nextStep: string;
  readonly source: ProjectToolSource;
  readonly updatedAt: number;
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

export interface ProjectToolDecision {
  readonly key: string;
  readonly content: string;
  readonly status: 'proposed' | 'accepted' | 'superseded';
  readonly revision: number;
  readonly source: ProjectToolSource;
  readonly updatedAt: number;
}

export interface ProjectToolMemory {
  readonly key: string;
  readonly content: string;
  readonly status: 'candidate' | 'active' | 'superseded' | 'retired';
  readonly revision: number;
  readonly source: ProjectToolSource;
  readonly updatedAt: number;
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
  readonly project: ProjectToolProject;
  readonly state: ProjectToolState | null;
  readonly tasks: readonly ProjectToolTask[];
  readonly decisions: readonly ProjectToolDecision[];
  readonly memories: readonly ProjectToolMemory[];
  readonly activity: readonly ProjectToolActivity[];
  readonly nextCursor: number;
}

export interface ProjectToolContext {
  readonly text: string;
  readonly sourceRefs: readonly ProjectToolSource[];
}

export interface ProjectToolPayload {
  readonly snapshot?: ProjectToolSnapshot;
  readonly context?: ProjectToolContext;
  readonly state?: ProjectToolState;
  readonly decision?: ProjectToolDecision;
  readonly memory?: ProjectToolMemory;
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
