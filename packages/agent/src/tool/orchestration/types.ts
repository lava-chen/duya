export enum ToolBatch {
  READ = 'read',
  WRITE = 'write',
  SYSTEM = 'system',
}

export interface BatchConfig {
  maxConcurrency: number
  timeout: number
}

export const BATCH_STRATEGY: Record<ToolBatch, BatchConfig> = {
  [ToolBatch.READ]: {
    maxConcurrency: 5,
    timeout: 60000,
  },
  [ToolBatch.WRITE]: {
    maxConcurrency: 1,
    timeout: 300000,
  },
  [ToolBatch.SYSTEM]: {
    maxConcurrency: 5,
    timeout: 300000,
  },
}

export const BATCH_EXECUTION_ORDER: readonly ToolBatch[] = [
  ToolBatch.READ,
  ToolBatch.WRITE,
  ToolBatch.SYSTEM,
]