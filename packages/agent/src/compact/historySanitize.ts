/** Compatibility adapter for Runtime-owned compact-history sanitation. */
import {
  sanitizeCompactedHistory,
  validateCompactedHistory,
  fitCompactedToBudget as fitRuntimeHistoryToBudget,
} from '@duya/agent-runtime/context/compact/historySanitize'
import type { Message } from '../types.js'
import { createWorkerCompactionContextModel } from '@duya/host/worker-compaction'

export { sanitizeCompactedHistory, validateCompactedHistory }

export function fitCompactedToBudget(messages: Message[], maxTokens: number): Message[] {
  return fitRuntimeHistoryToBudget(
    messages,
    maxTokens,
    createWorkerCompactionContextModel().estimateMessageTokens,
  )
}
