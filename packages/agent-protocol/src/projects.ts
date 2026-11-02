import type { Task } from './tasks.js';

/** Project metadata shared between Host and its clients. */
export interface HostProjectPathEntry {
  readonly path: string;
  readonly description: string | null;
}

/** Client-safe project projection. `paths` is decoded from its SQLite JSON column. */
export interface HostProjectRecord {
  readonly project_id: string;
  readonly canonical_root: string;
  readonly name: string;
  readonly description: string | null;
  readonly paths: readonly HostProjectPathEntry[];
  readonly icon: string | null;
  readonly color: string | null;
  readonly created_at: number;
  readonly last_seen_at: number;
  /** Stable conversation owner; replacing it never changes project/task identity. */
  readonly coordinator_session_id: string | null;
}

export interface HostProjectCreateInput {
  readonly name: string;
  readonly description?: string | null;
  readonly paths: readonly HostProjectPathEntry[];
  readonly icon?: string | null;
  readonly color?: string | null;
}

export interface HostProjectPatch {
  readonly name?: string;
  readonly description?: string | null;
  readonly paths?: readonly HostProjectPathEntry[];
  readonly icon?: string | null;
  readonly color?: string | null;
}

export interface HostProjectTaskLink {
  readonly projectId: string;
  readonly taskId: string;
  readonly coordinatorSessionId: string;
  readonly workSessionId: string | null;
  readonly updatedAt: number;
  readonly acceptanceStatus: 'pending' | 'accepted' | 'rejected';
}

export interface ProjectContinuitySource { readonly type: string; readonly id: string; }
export interface ProjectDecision {
  readonly key: string; readonly content: string;
  readonly status: 'proposed' | 'accepted' | 'superseded';
  readonly revision: number; readonly source: ProjectContinuitySource; readonly updatedAt: number;
}
export interface ProjectMemory {
  readonly key: string; readonly content: string;
  readonly status: 'candidate' | 'active' | 'superseded' | 'retired';
  readonly revision: number; readonly source: ProjectContinuitySource; readonly updatedAt: number;
}
export interface ProjectContinuityState {
  readonly revision: number; readonly currentState: string; readonly nextStep: string;
  readonly source: ProjectContinuitySource; readonly updatedAt: number;
}
export interface ProjectActivity {
  readonly cursor: number; readonly type: string; readonly taskId: string | null;
  readonly sessionId: string | null; readonly runId: string | null;
  readonly source: ProjectContinuitySource; readonly payload: Record<string, unknown>; readonly createdAt: number;
}
export interface ProjectTaskSnapshot { readonly task: Task | null; readonly link: HostProjectTaskLink; }

/** Which durable role a Session holds in a Project. */
export type ProjectSessionRole = 'coordinator' | 'work';

/** Session-scoped project context: the Project is derived from the Session, never from the caller's payload. */
export interface ProjectSessionContext {
  readonly projectId: string;
  readonly projectName: string;
  readonly role: ProjectSessionRole;
  readonly taskId: string | null;
  readonly text: string;
  readonly sourceRefs: readonly ProjectContinuitySource[];
}
export interface ProjectContinuitySnapshot {
  readonly project: HostProjectRecord;
  readonly state: ProjectContinuityState | null;
  readonly tasks: readonly ProjectTaskSnapshot[];
  readonly decisions: readonly ProjectDecision[];
  readonly memories: readonly ProjectMemory[];
  readonly activity: readonly ProjectActivity[];
  readonly nextCursor: number;
  /** Transcript remains authoritative in MessageLog; these identify where to read it. */
  readonly transcriptRefs: readonly { sessionId: string; role: 'coordinator' | 'work'; taskId?: string }[];
}

/** Versioned asynchronous API for durable project metadata. */
export interface HostProjectApiV1 {
  listProjects(): Promise<readonly HostProjectRecord[]>;
  getProject(projectId: string): Promise<HostProjectRecord | null>;
  createProject(input: HostProjectCreateInput): Promise<HostProjectRecord>;
  updateProject(projectId: string, patch: HostProjectPatch): Promise<HostProjectRecord | null>;
  deleteProject(projectId: string): Promise<boolean>;
  bindCoordinatorSession(projectId: string, sessionId: string): Promise<HostProjectRecord | null>;
  /** Clear the binding only when the given Session is the current coordinator. */
  clearCoordinatorSession(sessionId: string): Promise<boolean>;
  listProjectTasks(projectId: string): Promise<readonly HostProjectTaskLink[]>;
  bindProjectTask(projectId: string, taskId: string, coordinatorSessionId: string): Promise<HostProjectTaskLink>;
  bindWorkSession(projectId: string, taskId: string, workSessionId: string): Promise<HostProjectTaskLink | null>;
  getProjectContinuity(projectId: string, options?: { afterCursor?: number; limit?: number }): Promise<ProjectContinuitySnapshot | null>;
  getProjectContext(projectId: string, taskId?: string, maxCharacters?: number): Promise<{ text: string; sourceRefs: readonly ProjectContinuitySource[] } | null>;
  /** Resolve the Project/Task from a Session's durable binding and return its bounded context. */
  getSessionProjectContext(sessionId: string, maxCharacters?: number): Promise<ProjectSessionContext | null>;
  updateProjectState(input: { projectId: string; expectedRevision: number; currentState: string; nextStep: string; source: ProjectContinuitySource }): Promise<ProjectContinuityState | null>;
  updateProjectDecision(input: { projectId: string; key: string; content: string; status: ProjectDecision['status']; expectedRevision: number; source: ProjectContinuitySource }): Promise<ProjectDecision | null>;
  updateProjectMemory(input: { projectId: string; key: string; content: string; status: ProjectMemory['status']; expectedRevision: number; source: ProjectContinuitySource }): Promise<ProjectMemory | null>;
  updateProjectTaskAcceptance(input: { projectId: string; taskId: string; status: 'accepted' | 'rejected'; source: ProjectContinuitySource }): Promise<HostProjectTaskLink | null>;
  listProjectMemoryHistory(projectId: string, key: string, limit?: number): Promise<readonly ProjectMemory[]>;
  listProjectDecisionHistory(projectId: string, key: string, limit?: number): Promise<readonly ProjectDecision[]>;
}
