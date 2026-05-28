import { z } from 'zod'
import { BaseTool } from '../../../tool/BaseTool.js'
import type { ToolResult } from '../../../tool/types.js'
import type { ToolUseContext } from '../../../types.js'
import type { LiteratureStore } from '../storage/LiteratureStore.js'

const inputSchema = z.object({
  kind: z.enum(['paper', 'book', 'webpage', 'report', 'thesis', 'dataset']),
  title: z.string().min(1),
  authors: z.array(z.string()).default([]),
  year: z.number().int().optional(),
  venue: z.string().optional(),
  doi: z.string().optional(),
  arxivId: z.string().optional(),
  url: z.string().optional(),
  filePath: z.string().optional(),
  citationKey: z.string().optional(),
  bibtex: z.string().optional(),
  projectIds: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
})

export class AddSourceTool extends BaseTool {
  readonly name = 'literature:add_source'
  readonly description = 'Add a new literature source (paper, book, webpage, etc.) to the library'
  readonly input_schema = inputSchema

  private store: LiteratureStore

  constructor(store: LiteratureStore) {
    super()
    this.store = store
  }

  async execute(input: Record<string, unknown>, _workingDirectory?: string, _context?: ToolUseContext): Promise<ToolResult> {
    const parsed = inputSchema.parse(input)
    const source = await this.store.createSource(parsed)

    return {
      id: source.id,
      name: this.name,
      result: JSON.stringify(source, null, 2),
      metadata: { sourceId: source.id },
    }
  }
}