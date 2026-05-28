import { z } from 'zod'
import { BaseTool } from '../../../tool/BaseTool.js'
import type { ToolResult } from '../../../tool/types.js'
import type { ToolUseContext } from '../../../types.js'
import type { LiteratureStore } from '../storage/LiteratureStore.js'
import type { PaperCard } from '../types.js'

const inputSchema = z.object({
  sourceId: z.string().min(1),
  researchProblem: z.string().default(''),
  methodSummary: z.string().default(''),
  datasets: z.array(z.string()).default([]),
  metrics: z.array(z.string()).default([]),
  keyFindings: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([]),
  reusableIdeas: z.array(z.string()).default([]),
  evidenceSpanIds: z.array(z.string()).default([]),
})

export class ExtractPaperCardTool extends BaseTool {
  readonly name = 'literature:extract_paper_card'
  readonly description = 'Extract or update a structured paper card (problem, method, findings, limitations, ideas) from a literature source'
  readonly input_schema = inputSchema

  private store: LiteratureStore

  constructor(store: LiteratureStore) {
    super()
    this.store = store
  }

  async execute(input: Record<string, unknown>, _workingDirectory?: string, _context?: ToolUseContext): Promise<ToolResult> {
    const { sourceId, researchProblem, methodSummary, datasets, metrics, keyFindings, limitations, reusableIdeas, evidenceSpanIds } = inputSchema.parse(input)

    const source = await this.store.getSource(sourceId)
    if (!source) {
      return {
        id: `paper_card_${Date.now()}`,
        name: this.name,
        result: `No source found with ID: ${sourceId}`,
        error: true,
      }
    }

    const card: PaperCard = {
      researchProblem,
      methodSummary,
      datasets,
      metrics,
      keyFindings,
      limitations,
      reusableIdeas,
    }

    const record = await this.store.upsertPaperCard(sourceId, card, evidenceSpanIds)

    return {
      id: record.id,
      name: this.name,
      result: JSON.stringify(record, null, 2),
      metadata: { sourceId, paperCardId: record.id },
    }
  }
}