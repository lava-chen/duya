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

/**
 * A project task, projected from the canonical task store together with the
 * project binding that says which coordinator owns it and which work session
 * executes it.
 *
 * The task CONTENT lives in the task store; this is a projection of it plus
 * the binding. A client never writes task content through the project API, so
 * there is no second task state machine behind this shape.
 */
export interface HostProjectTaskState {
  readonly taskId: string;
  readonly subject: string;
  readonly description: string;
  /** Canonical task status. `unknown` when the task row is missing. */
  readonly status: string;
  readonly activeForm: string | null;
  readonly owner: string | null;
  readonly blocks: readonly string[];
  readonly blockedBy: readonly string[];
  readonly coordinatorSessionId: string;
  readonly workSessionId: string | null;
  readonly updatedAt: number;
}

/**
 * A working session of a project.
 *
 * Two origins, and the difference matters: `spawned` sessions are children of
 * the coordinator session in the spawn lineage, `bound` sessions were attached
 * to a project task explicitly. A session can be both; the binding wins,
 * because it is the stronger fact.
 */
export type HostProjectWorkSessionOrigin = 'spawned' | 'bound';

export interface HostProjectWorkSession {
  readonly sessionId: string;
  readonly title: string;
  readonly workingDirectory: string;
  /** Session row status. `unknown` when the session row is missing. */
  readonly status: string;
  readonly updatedAt: number;
  /** The project task this session executes, when one is bound. */
  readonly taskId: string | null;
  readonly origin: HostProjectWorkSessionOrigin;
}

/**
 * The unified project state.
 *
 * One read, one authority: the project row, its coordinator conversation, the
 * project tasks and the working sessions are projected together so a client
 * never has to assemble a project view from several sources that could
 * disagree with each other.
 */
export interface HostProjectState {
  readonly project: HostProjectRecord;
  readonly coordinatorSessionId: string | null;
  readonly tasks: readonly HostProjectTaskState[];
  readonly workSessions: readonly HostProjectWorkSession[];
  /** When the projection was taken. */
  readonly observedAt: number;
}

/** Versioned asynchronous API for durable project metadata. */
export interface HostProjectApiV1 {
  listProjects(): Promise<readonly HostProjectRecord[]>;
  getProject(projectId: string): Promise<HostProjectRecord | null>;
  createProject(input: HostProjectCreateInput): Promise<HostProjectRecord>;
  updateProject(projectId: string, patch: HostProjectPatch): Promise<HostProjectRecord | null>;
  deleteProject(projectId: string): Promise<boolean>;
  bindCoordinatorSession(projectId: string, sessionId: string): Promise<HostProjectRecord | null>;
  listProjectTasks(projectId: string): Promise<readonly HostProjectTaskLink[]>;
  bindProjectTask(projectId: string, taskId: string, coordinatorSessionId: string): Promise<HostProjectTaskLink>;
  bindWorkSession(projectId: string, taskId: string, workSessionId: string): Promise<HostProjectTaskLink | null>;
  getProjectContinuity(projectId: string, options?: { afterCursor?: number; limit?: number }): Promise<ProjectContinuitySnapshot | null>;
  getProjectContext(projectId: string, taskId?: string, maxCharacters?: number): Promise<{ text: string; sourceRefs: readonly ProjectContinuitySource[] } | null>;
  updateProjectState(input: { projectId: string; expectedRevision: number; currentState: string; nextStep: string; source: ProjectContinuitySource }): Promise<ProjectContinuityState | null>;
  updateProjectDecision(input: { projectId: string; key: string; content: string; status: ProjectDecision['status']; expectedRevision: number; source: ProjectContinuitySource }): Promise<ProjectDecision | null>;
  updateProjectMemory(input: { projectId: string; key: string; content: string; status: ProjectMemory['status']; expectedRevision: number; source: ProjectContinuitySource }): Promise<ProjectMemory | null>;
  updateProjectTaskAcceptance(input: { projectId: string; taskId: string; status: 'accepted' | 'rejected'; source: ProjectContinuitySource }): Promise<HostProjectTaskLink | null>;
  listProjectMemoryHistory(projectId: string, key: string, limit?: number): Promise<readonly ProjectMemory[]>;
  listProjectDecisionHistory(projectId: string, key: string, limit?: number): Promise<readonly ProjectDecision[]>;
  /**
   * Read the whole project state in one projection.
   *
   * Returns null when the project does not exist. This is the read the Desktop
   * project workspace uses: the coordinator conversation, the tasks and the
   * working sessions all come from the same observation, so the view cannot
   * show a coordinator that disagrees with the task it is bound to.
   */
  getProjectState(projectId: string): Promise<HostProjectState | null>;
}
