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
  constructor(config: CompactionManagerConfig = {}, onTranscriptRewrite?: () => void) {
    super(config, createLegacyCompactionRuntimePorts(undefined, onTranscriptRewrite))
  }
}

/**
 * `onTranscriptRewrite` is bound by the session owner so the invalidation is
 * scoped to that session. Omitting it leaves Runtime with no callback, which
 * is the right behaviour for callers that do not own a read-first ledger.
 */
export function createCompactionManager(
  config: CompactionManagerConfig = {},
  onTranscriptRewrite?: () => void,
): CompactionManager {
  return new CompactionManager(config, onTranscriptRewrite)
}
