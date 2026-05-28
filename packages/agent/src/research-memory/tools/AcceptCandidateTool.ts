import { z } from 'zod'
import { BaseTool } from '../../tool/BaseTool.js'
import type { ToolResult } from '../../tool/types.js'
import type { ToolUseContext } from '../../types.js'
import type { ResearchMemoryStore } from '../store.js'

const inputSchema = z.object({
  candidateId: z.string().min(1),
  autoReview: z.boolean().default(false),
})

export class AcceptCandidateTool extends BaseTool {
  readonly name = 'research_memory:accept_candidate'
  readonly description = 'Accept a pending research memory candidate, making it durable research memory. Set autoReview=true to apply confidence-based auto-review rules.'
  readonly input_schema = inputSchema

  private store: ResearchMemoryStore

  constructor(store: ResearchMemoryStore) {
    super()
    this.store = store
  }

  async execute(input: Record<string, unknown>, _workingDirectory?: string, _context?: ToolUseContext): Promise<ToolResult> {
    const { candidateId, autoReview } = inputSchema.parse(input)

    if (autoReview) {
      const candidate = await this.store.getCandidate(candidateId)
      if (candidate) {
        const reviewResult = this.store.applyAutoReview(candidate)
        if (reviewResult === 'auto_accept') {
          const accepted = await this.store.acceptCandidate(candidateId)
          return {
            id: candidateId,
            name: this.name,
            result: JSON.stringify({
              accepted,
              reviewResult: 'auto_accept',
              message: 'Auto-accepted: confidence exceeds threshold for this memory type.',
            }, null, 2),
            metadata: { candidateId, status: 'accepted', autoAccepted: true },
          }
        }
        if (reviewResult === 'auto_reject') {
          await this.store.rejectCandidate(candidateId)
          return {
            id: candidateId,
            name: this.name,
            result: JSON.stringify({
              reviewResult: 'auto_reject',
              message: 'Auto-rejected: confidence below threshold for hypothesis-type candidates.',
            }, null, 2),
            metadata: { candidateId, status: 'rejected', autoRejected: true },
          }
        }
      }
    }

    const accepted = await this.store.acceptCandidate(candidateId)

    return {
      id: candidateId,
      name: this.name,
      result: JSON.stringify({
        accepted,
        reviewResult: autoReview ? 'manual' : 'explicit',
        message: 'Candidate accepted and persisted to research memory.',
      }, null, 2),
      metadata: { candidateId, status: 'accepted' },
    }
  }
}