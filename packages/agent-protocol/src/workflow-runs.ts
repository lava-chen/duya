import type { JournalRecord } from './workflow-journal.js';

export type WorkflowRunStatus =
  | 'inactive'
  | 'planning'
  | 'awaiting_confirm'
  | 'active'
  | 'verifying'
  | 'user_paused'
  | 'backoff_paused'
  | 'no_progress_paused'
  | 'infra_paused'
  | 'blocked'
  | 'budget_limited'
  | 'complete'
  | 'stopped'
  | 'interrupted'
  | 'cancelled'
  | 'failed';

export type WorkflowTriggerKind = 'manual' | 'cron' | 'bot' | 'http';
export type WorkflowRunOrigin = 'library' | 'session' | 'agent' | 'cron';
export type WorkflowRunScope = 'project' | 'global';

export interface WorkflowArtifactRef {
  id: string;
  name: string;
  contentType: string;
  bytes: number;
  /** Path relative to the run's artifact root, written by the runtime child. */
  relPath: string;
}

export interface WorkflowRun {
  id: string;
  workflowName: string;
  workflowVersionId: string | null;
  status: WorkflowRunStatus;
  triggerKind: WorkflowTriggerKind | null;
  dedupKey: string | null;
  params: Record<string, unknown>;
  waitTill: number | null;
  retryOf: string | null;
  pauseMessage: string | null;
  origin: WorkflowRunOrigin;
  scope: WorkflowRunScope | null;
  /** Working directory the run executes in. */
  projectDir: string | null;
  parentSessionId: string | null;
  artifacts: WorkflowArtifactRef[];
  /** One-paragraph outcome summary rendered in the run card. */
  summary: string | null;
  finishedAt: number | null;
  spentTokens: number | null;
  /** Run-level model override recorded for restart/resume reuse. */
  agentModel: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowRunCreateInput {
  id?: string;
  workflowName: string;
  workflowVersionId?: string | null;
  status?: WorkflowRunStatus;
  triggerKind?: WorkflowTriggerKind | null;
  dedupKey?: string | null;
  params?: Record<string, unknown>;
  retryOf?: string | null;
  origin?: WorkflowRunOrigin;
  scope?: WorkflowRunScope | null;
  projectDir?: string | null;
  parentSessionId?: string | null;
  summary?: string | null;
  agentModel?: string | null;
}

export interface WorkflowRunOutcomeInput {
  status: WorkflowRunStatus;
  summary?: string | null;
  artifacts?: WorkflowArtifactRef[];
  spentTokens?: number | null;
  finishedAt?: number | null;
}

export interface WorkflowRunFilter {
  status?: WorkflowRunStatus;
  workflowName?: string;
  origin?: WorkflowRunOrigin;
  parentSessionId?: string;
  limit?: number;
  offset?: number;
}

export interface WorkflowRunSnapshot {
  runId: string;
  definition: unknown;
  /** Full SHA-256 of the frozen definition source used by this run. */
  definitionHash?: string;
  /** `dag` hashes normalized WorkflowDef; `dwf-script` hashes script body + frontmatter. */
  definitionHashSource?: 'dag' | 'dwf-script';
  /** Run-level scheduler bound; separate from provider-level admission. */
  maxConcurrency?: number;
  nodeStack: Array<{ nodeId: string; status: string; output?: unknown }>;
  /**
   * @deprecated Journal records live in `workflow_run_events`. This remains
   * for reading snapshots written before migration 31; new writes append
   * records through `appendJournalRecord`.
   */
  journal: JournalRecord[];
  updatedAt: number;
}

/** Snapshot write input; journal records are ingested into the event table. */
export interface WorkflowRunSnapshotSaveInput {
  runId: string;
  definition: unknown;
  definitionHash?: string;
  definitionHashSource?: WorkflowRunSnapshot['definitionHashSource'];
  maxConcurrency?: WorkflowRunSnapshot['maxConcurrency'];
  nodeStack?: WorkflowRunSnapshot['nodeStack'];
  /** Legacy compatibility; records are persisted in the event table. */
  journal?: JournalRecord[];
  updatedAt?: number;
}

/** Typed durable workflow-run operations owned by the Duya Host. */
export interface WorkflowRunApiV1 {
  createRun(input: WorkflowRunCreateInput): Promise<WorkflowRun>;
  getRun(id: string): Promise<WorkflowRun | null>;
  getRunByDedupKey(dedupKey: string): Promise<WorkflowRun | null>;
  listRuns(filter?: WorkflowRunFilter): Promise<WorkflowRun[]>;
  listActiveRunIds(): Promise<string[]>;
  updateStatus(id: string, status: WorkflowRunStatus, pauseMessage?: string | null): Promise<boolean>;
  finishRun(id: string, outcome: WorkflowRunOutcomeInput): Promise<boolean>;
  setWaitTill(id: string, waitTill: number | null): Promise<boolean>;
  setVersionId(id: string, versionId: string): Promise<boolean>;
  listWaitingPast(nowMs: number): Promise<WorkflowRun[]>;
  reconcileStaleRuns(activeRunIds: readonly string[]): Promise<WorkflowRun[]>;
  saveSnapshot(snapshot: WorkflowRunSnapshotSaveInput): Promise<boolean>;
  loadSnapshot(runId: string): Promise<WorkflowRunSnapshot | null>;
  appendJournalRecord(runId: string, record: JournalRecord): Promise<boolean>;
  /** Replace a journal after replay pruning; implementations must be atomic. */
  replaceJournal(runId: string, records: JournalRecord[]): Promise<boolean>;
  listEvents(runId: string, afterSeq?: number): Promise<JournalRecord[]>;
  latestEventSeq(runId: string): Promise<number | null>;
  getEventCount(runId: string): Promise<number>;
  loadJournal(runId: string): Promise<JournalRecord[]>;
  deleteRun(id: string): Promise<boolean>;
}
