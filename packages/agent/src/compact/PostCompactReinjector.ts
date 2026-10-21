/** Compatibility adapter for Runtime reinjection with Host token estimates. */
import {
  PostCompactReinjector as RuntimePostCompactReinjector,
  extractFileState as extractRuntimeFileState,
  type FileStateEntry,
  type ReinjectorConfig,
  type ReinjectResult,
  type SkillContextEntry,
  type ToolState,
} from '@duya/agent-runtime/context/compact/PostCompactReinjector'
import type { Message } from '../types.js'
import { createWorkerCompactionContextModel } from '@duya/host/worker-compaction'

export type { FileStateEntry, ReinjectorConfig, ReinjectResult, SkillContextEntry, ToolState }

const contextModel = createWorkerCompactionContextModel()
const clock = { now: () => Date.now() }

export function extractFileState(messages: Message[]): Map<string, FileStateEntry> {
  return extractRuntimeFileState(messages, clock)
}

export class PostCompactReinjector extends RuntimePostCompactReinjector {
  constructor(config: Partial<ReinjectorConfig> = {}) {
    super(config, {
      estimateTextTokens: contextModel.estimateTextTokens,
      clock,
    })
  }
}

export function createPostCompactReinjector(config: Partial<ReinjectorConfig> = {}): PostCompactReinjector {
  return new PostCompactReinjector(config)
}
