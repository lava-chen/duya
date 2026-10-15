/** Compatibility entry for the Runtime-owned compaction manager. */
import {
  CompactionManager as RuntimeCompactionManager,
  type CompactionManagerConfig,
} from '@duya/agent-runtime/context/compact'
import { createLegacyCompactionRuntimePorts } from './bound-ports.js'

export {
  type CompactionManagerConfig,
  type CompactionManagerEvent,
  type CompactionProbe,
  type EnhancedCompactionResult,
} from '@duya/agent-runtime/context/compact'

export class CompactionManager extends RuntimeCompactionManager {
  constructor(config: CompactionManagerConfig = {}) {
    super(config, createLegacyCompactionRuntimePorts())
  }
}

export function createCompactionManager(config: CompactionManagerConfig = {}): CompactionManager {
  return new CompactionManager(config)
}
