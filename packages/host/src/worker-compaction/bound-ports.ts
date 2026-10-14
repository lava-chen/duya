import { createWorkerCompactionRuntimePorts } from '@duya/host/worker-compaction'
import type { CompactionRuntimePorts } from '@duya/agent-runtime/context/compact'
import { getLogger } from '@duya/host/worker-logger'

/** Compatibility binding for callers that still enter through @duya/agent. */
export function createLegacyCompactionRuntimePorts(
  summarizer?: (text: string, prompt: string) => Promise<string>,
): CompactionRuntimePorts {
  const logger = getLogger()
  return createWorkerCompactionRuntimePorts({
    logger,
    clock: { now: () => Date.now() },
    ...(summarizer === undefined ? {} : { summarizer }),
  })
}
