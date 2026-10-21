/** Context-window resolution belongs to Host; Runtime receives the resolved budget. */
export type { ContextWindowSource as CompactionContextWindowSource } from './contracts.js'

export interface CompactionContextWindow {
  contextWindow: number
  source: import('./contracts.js').ContextWindowSource
  modelId?: string
}
