import { z } from 'zod'
import { BaseTool } from '../../tool/BaseTool.js'
import type { ToolResult } from '../../tool/types.js'
import type { ToolUseContext } from '../../types.js'
import type { ResearchMemoryStore } from '../store.js'

const inputSchema = z.object({
  hypothesisId: z.string().min(1),
  status: z.enum(['proposed', 'supported', 'weakened', 'rejected', 'accepted', 'published']).optional(),
  supersededBy: z.string().optional(),
  supportingEvidenceIds: z.array(z.string()).optional(),
  contradictingEvidenceIds: z.array(z.string()).optional(),
  relatedSourceIds: z.array(z.string()).optional(),
})

export class UpdateHypothesisTool extends BaseTool {
  readonly name = 'research_memory:update_hypothesis'
  readonly description = 'Update a research hypothesis status, evidence links, or superseding reference'
  readonly input_schema = inputSchema

  private store: ResearchMemoryStore

  constructor(store: ResearchMemoryStore) {
    super()
    this.store = store
  }

  async execute(input: Record<string, unknown>, _workingDirectory?: string, _context?: ToolUseContext): Promise<ToolResult> {
    const { hypothesisId, ...update } = inputSchema.parse(input)
    const hypothesis = await this.store.updateHypothesis(hypothesisId, update)

    if (!hypothesis) {
      return {
        id: `update_hypothesis_${Date.now()}`,
        name: this.name,
        result: `Hypothesis not found: ${hypothesisId}`,
        error: true,
      }
    }

    return {
      id: hypothesisId,
      name: this.name,
      result: JSON.stringify(hypothesis, null, 2),
      metadata: { hypothesisId, newStatus: hypothesis.status },
    }
  }
}