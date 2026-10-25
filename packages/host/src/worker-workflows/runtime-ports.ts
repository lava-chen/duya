import { createHash, randomUUID } from 'node:crypto';
import { createResumeTokenPort } from './resume-token.js';
import type { WorkflowRuntimePorts } from '@duya/workflow';

export function createWorkflowRuntimePorts(secret?: string): WorkflowRuntimePorts {
  return {
    clock: {
      nowMs: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    random: { next: () => Math.random() },
    ids: { newId: () => randomUUID() },
    hash: { sha256: (input) => createHash('sha256').update(input).digest('hex') },
    resumeTokens: createResumeTokenPort(secret ?? 'duya-workflow-dev-secret'),
  };
}
