// src/types/bash-task.ts
// Shared type for bash background task snapshots streamed from the agent
// worker process to the renderer via the bash_task:update IPC channel.
// Mirrors BashBackgroundTask in packages/agent/src/session/bash-task-registry.ts
// but stays renderer-friendly (no Node-specific fields, all numbers are
// plain numbers) so it can be used directly in React state.

export type BashTaskStatus =
  | 'running'
  | 'completed'
  | 'killed'
  | 'disk_limit'
  | 'error';

export interface BashTaskProgress {
  bytes: number;
  pid: number | null;
  elapsed: number;
  timestamp: number;
}

export interface BashBackgroundTaskSnapshot {
  id: string;
  pid: number;
  outputFile: string;
  command: string;
  status: BashTaskStatus;
  startTime: number;
  endTime?: number;
  exitCode?: number;
  error?: string;
  lastProgress?: BashTaskProgress;
}
