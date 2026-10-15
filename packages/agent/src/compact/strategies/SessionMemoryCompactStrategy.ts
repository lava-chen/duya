/** Compatibility adapter for the Runtime-owned session memory compactor. */
import {
  SessionMemoryCompactStrategy as RuntimeSessionMemoryCompactStrategy,
  type SessionMemoryCompactConfig,
  type SkillInvocation,
  type FileChangeRecord,
  type SessionMemoryData,
} from '@duya/agent-runtime/context/compact'
import { createLegacyCompactionRuntimePorts } from '../compaction-ports.js'

export type { SessionMemoryCompactConfig, SkillInvocation, FileChangeRecord, SessionMemoryData }

export class SessionMemoryCompactStrategy extends RuntimeSessionMemoryCompactStrategy {
  constructor(config: Partial<SessionMemoryCompactConfig> = {}) {
    super(config, createLegacyCompactionRuntimePorts())
  }
}

export function createSessionMemoryCompactStrategy(
  config: Partial<SessionMemoryCompactConfig> = {},
): SessionMemoryCompactStrategy {
  return new SessionMemoryCompactStrategy(config)
}
