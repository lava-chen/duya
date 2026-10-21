import {
  applyLiveAnchorCorrection,
  computeContextEstimate,
  estimateContextMessageTokens,
  estimateContextTextTokens,
  normalizePromptTokens,
  resolveContextWindow,
} from '@duya/ai'
import type {
  CompactionClockPort,
  CompactionLoggerPort,
  CompactionRuntimePorts,
  ContextModelPort,
  ContextWindowSource,
} from '@duya/agent-runtime/context/compact'

/**
 * Bind the canonical AI context estimator to the transport-neutral Runtime
 * port. Runtime owns the accounting and compaction decisions; this Host
 * adapter keeps provider/model knowledge at the application boundary.
 */
export function createWorkerCompactionContextModel(): ContextModelPort {
  return {
    estimateMessageTokens: (message) => estimateContextMessageTokens(message),
    estimateTextTokens: estimateContextTextTokens,
    computeContextEstimate: (messages, options) => computeContextEstimate(messages, options),
    normalizePromptTokens: (usage) => normalizePromptTokens(usage),
    applyLiveAnchorCorrection: (input) => applyLiveAnchorCorrection(input),
  }
}

/** Build the complete Runtime port bundle for a worker-owned compaction manager. */
export function createWorkerCompactionRuntimePorts(input: {
  logger: CompactionLoggerPort
  clock: CompactionClockPort
  summarizer?: (text: string, prompt: string) => Promise<string>
}): CompactionRuntimePorts {
  return {
    contextModel: createWorkerCompactionContextModel(),
    logger: input.logger,
    clock: input.clock,
    ...(input.summarizer === undefined ? {} : { summarizer: input.summarizer }),
  }
}

export interface WorkerCompactionContextWindow {
  contextWindow: number
  source: ContextWindowSource
}

export function resolveWorkerCompactionContextWindow(input: {
  capabilityContextWindow?: number
  modelId?: string
}): WorkerCompactionContextWindow {
  return resolveContextWindow(input)
}
