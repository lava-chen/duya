import { z } from 'zod'
import { BaseTool } from '../../../tool/BaseTool.js'
import type { ToolResult } from '../../../tool/types.js'
import type { ToolUseContext } from '../../../types.js'
import type { LiteratureStore } from '../storage/LiteratureStore.js'

const inputSchema = z.object({
  query: z.string().min(1),
  sourceId: z.string().optional(),
  page: z.number().int().optional(),
  section: z.string().optional(),
})

export class SearchEvidenceTool extends BaseTool {
  readonly name = 'literature:search_evidence'
  readonly description = 'Search evidence spans (text segments) from literature sources'
  readonly input_schema = inputSchema

  private store: LiteratureStore

  constructor(store: LiteratureStore) {
    super()
    this.store = store
  }

  async execute(input: Record<string, unknown>, _workingDirectory?: string, _context?: ToolUseContext): Promise<ToolResult> {
    const { query, ...options } = inputSchema.parse(input)
    const spans = await this.store.searchEvidence(query, options)

    return {
      id: `search_evidence_${Date.now()}`,
      name: this.name,
      result: JSON.stringify(spans, null, 2),
      metadata: { count: spans.length },
    }
  }
}