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
}
