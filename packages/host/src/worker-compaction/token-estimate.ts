/** Compatibility adapter binding Runtime token helpers to Host's estimator. */
import {
  TokenBudgetManager,
  DEFAULT_BUDGET_CONFIG,
  REARM_WINDOW_FRACTION,
  TARGET_WINDOW_FRACTION,
} from '@duya/agent-runtime/context/compact/tokenBudget'
import { createWorkerCompactionContextModel } from '@duya/host/worker-compaction'

export { TokenBudgetManager, DEFAULT_BUDGET_CONFIG, REARM_WINDOW_FRACTION, TARGET_WINDOW_FRACTION }
export type { TokenBudgetConfig } from '@duya/agent-runtime/context/compact/tokenBudget'

const estimate = createWorkerCompactionContextModel().estimateMessageTokens

export function estimateMessageTokens(message: { role: string; content: string | unknown }): number {
  return estimate(message as { role: string; content: string | unknown[] })
}

export function estimateMessagesTokens(
  messages: readonly { role: string; content: string | unknown }[],
): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
}
