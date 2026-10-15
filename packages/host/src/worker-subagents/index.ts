export { BackgroundAgentLifecycle, backgroundAgentLifecycle, cleanupRegistry, getBackgroundAgentLifecycle } from './background-lifecycle.js';
export type { RegisterInput, InFlightChangeListener, KillOutcome } from './background-lifecycle.js';
export type { AgentProgressEvent } from './types.js';
export type { ProgressSnapshot, TaskRecord, TaskStatus } from './task-state.js';
export { applyProgressEvent, buildChatAgentProgressPayload, extractResultFromLastMessage } from './progress-bridge.js';
export type { AgentProgressPayloadMeta, BridgeDeps } from './progress-bridge.js';
export { OutputFileWriter } from './output-file-writer.js';
export { ProgressTracker, RECENT_ACTIVITIES_CAP } from './progress-tracker.js';
export { CleanupRegistry } from './cleanup-registry.js';
export * from './task-verification.js';
export { createWorkerSubagentService, WorkerSubagentService } from './service.js';
export type {
  WorkerSubagentAgentDefinition,
  WorkerSubagentExecutionContext,
  WorkerSubagentRunRequest,
  WorkerSubagentServicePorts,
  WorkerSubagentToolInput,
  WorkerSubagentToolResult,
} from './types.js';
export { resolveResumeTarget } from './resume-target.js';
export type { ResolveResumeTargetInput, ResumeTarget, ResumeTargetError, ResumeErrorCode } from './resume-target.js';
