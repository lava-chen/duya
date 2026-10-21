import type { CompactionRuntimePorts } from '@duya/agent-runtime/context/compact'
import { createWorkerCompactionContextModel } from '@duya/host/worker-compaction'

export function createCompactionTestPorts(now: () => number = () => 1_700_000_000_000): CompactionRuntimePorts {
  return {
    contextModel: createWorkerCompactionContextModel(),
    clock: { now },
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
    },
  }
}
