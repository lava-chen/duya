// src/types/hook-task.ts
// Shared type for background hook task snapshots streamed from the agent
// worker process to the renderer via the hook_task:update IPC channel.
// Mirrors HookBackgroundTask in
// packages/agent/src/hooks/task-registry.ts but stays renderer-friendly
// (no Node-specific fields) so it can be used directly in React state.

export type HookTaskStatus = 'running' | 'completed' | 'killed' | 'error';

export interface HookTaskSnapshot {
  id: string;
  /** Hook event that spawned this task (e.g. 'UserPromptSubmit'). */
  event: string;
  /** Hook command type ('command' | 'process'). */
  hookType: string;
  /** Human-readable command line for display. */
  command: string;
  /** Parent session id. */
  sessionId: string;
  /** Whether completion wakes the model (asyncRewake). */
  rewake: boolean;
  pid: number | null;
  outputFile: string;
  status: HookTaskStatus;
  startTime: number;
  endTime?: number;
  exitCode?: number;
  error?: string;
}
