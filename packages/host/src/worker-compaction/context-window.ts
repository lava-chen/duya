/** Compatibility binding for Host-owned model context-window resolution. */
import { resolveWorkerCompactionContextWindow } from '@duya/host/worker-compaction'
export { DEFAULT_CONTEXT_WINDOW } from '@duya/agent-runtime/context/compact/types'
export type {
  ContextWindowSource as CompactionContextWindowSource,
} from '@duya/agent-runtime/context/compact/contracts'

export type CompactionContextWindow = {
  contextWindow: number
  source: import('@duya/agent-runtime/context/compact/contracts').ContextWindowSource
}

export function resolveCompactionContextWindow(input: {
  capabilityContextWindow?: number
  modelId?: string
}): CompactionContextWindow {
  return resolveWorkerCompactionContextWindow(input)
}
