import { z } from 'zod'
import { BaseTool } from '../../../tool/BaseTool.js'
import type { ToolResult } from '../../../tool/types.js'
import type { ToolUseContext } from '../../../types.js'
import type { LiteratureStore } from '../storage/LiteratureStore.js'

const inputSchema = z.object({
  query: z.string().min(1),
  kind: z.enum(['paper', 'book', 'webpage', 'report', 'thesis', 'dataset']).optional(),
  projectId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  yearFrom: z.number().int().optional(),
  yearTo: z.number().int().optional(),
  limit: z.number().int().min(1).max(200).default(50),
})

export class SearchSourcesTool extends BaseTool {
  readonly name = 'literature:search_sources'
  readonly description = 'Search literature sources by metadata (title, DOI, kind, year range, tags)'
  readonly input_schema = inputSchema

  private store: LiteratureStore

  constructor(store: LiteratureStore) {
    super()
    this.store = store
  }

  async execute(input: Record<string, unknown>, _workingDirectory?: string, _context?: ToolUseContext): Promise<ToolResult> {
    const { query, limit, ...options } = inputSchema.parse(input)
    const sources = await this.store.listSources({ search: query, limit, ...options })

    return {
      id: `search_sources_${Date.now()}`,
      name: this.name,
      result: JSON.stringify(sources, null, 2),
      metadata: { count: sources.length },
    }
  }
}