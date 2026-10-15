/** Compatibility adapter binding legacy cut-point calls to Host estimation. */
import {
  findCutPoint as findRuntimeCutPoint,
  type CutPointResult,
} from '@duya/agent-runtime/context/compact/tokenBudgetCut'
import type { Message } from '../types.js'
import { createWorkerCompactionContextModel } from '@duya/host/worker-compaction'

export {
  TURN_PREFIX_SUMMARIZATION_PROMPT,
  SUMMARIZATION_PROMPT,
  UPDATE_SUMMARIZATION_PROMPT,
  buildSummarizationPrompt,
  generateTurnPrefixSummary,
  createFileOps,
  extractFileOpsFromMessages,
  computeFileLists,
  formatFileOperations,
  serializeMessagesForSummary,
  DEFAULT_CUT_CONFIG,
  type CutPointResult,
  type TokenBudgetCutConfig,
  type FileOperations,
} from '@duya/agent-runtime/context/compact/tokenBudgetCut'

const estimateMessage = createWorkerCompactionContextModel().estimateMessageTokens

export function findCutPoint(
  messages: Message[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
): CutPointResult {
  return findRuntimeCutPoint(messages, startIndex, endIndex, keepRecentTokens, estimateMessage)
}
