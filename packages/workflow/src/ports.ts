import type { WorkflowHashPort } from './hash.js';
import type { ResumeTokenPort } from './resume-token.js';

export interface WorkflowClockPort {
  nowMs(): number;
  sleep(ms: number): Promise<void>;
}

export interface WorkflowRandomPort {
  next(): number;
}

export interface WorkflowIdPort {
  newId(): string;
}

export interface WorkflowRuntimePorts {
  clock: WorkflowClockPort;
  random: WorkflowRandomPort;
  ids: WorkflowIdPort;
  hash: WorkflowHashPort;
  resumeTokens: ResumeTokenPort;
}
