import { z } from 'zod'
import { BaseTool } from '../../tool/BaseTool.js'
import type { ToolResult } from '../../tool/types.js'
import type { ToolUseContext } from '../../types.js'
import type { ResearchMemoryStore } from '../store.js'

const inputSchema = z.object({
  projectId: z.string().min(1),
  status: z.enum(['pending', 'accepted', 'rejected', 'merged']).optional(),
})

export class ListCandidatesTool extends BaseTool {
  readonly name = 'research_memory:list_candidates'
  readonly description = 'List research memory candidates awaiting review in the Memory Inbox'
  readonly input_schema = inputSchema

  private store: ResearchMemoryStore

  constructor(store: ResearchMemoryStore) {
    super()
    this.store = store
  }

  async execute(input: Record<string, unknown>, _workingDirectory?: string, _context?: ToolUseContext): Promise<ToolResult> {
    const { projectId, status } = inputSchema.parse(input)
    const candidates = await this.store.listCandidatesByProject(projectId, status)

    return {
      id: `list_candidates_${Date.now()}`,
      name: this.name,
      result: JSON.stringify(candidates, null, 2),
      metadata: { count: candidates.length, projectId },
    }
  }
}