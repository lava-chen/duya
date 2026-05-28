import { z } from 'zod'
import { BaseTool } from '../../tool/BaseTool.js'
import type { ToolResult } from '../../tool/types.js'
import type { ToolUseContext } from '../../types.js'
import type { ResearchMemoryStore } from '../store.js'

const inputSchema = z.object({
  projectId: z.string().min(1),
})

export class ListHypothesesTool extends BaseTool {
  readonly name = 'research_memory:list_hypotheses'
  readonly description = 'List all hypotheses for a research project, including their status and evidence references'
  readonly input_schema = inputSchema

  private store: ResearchMemoryStore

  constructor(store: ResearchMemoryStore) {
    super()
    this.store = store
  }

  async execute(input: Record<string, unknown>, _workingDirectory?: string, _context?: ToolUseContext): Promise<ToolResult> {
    const { projectId } = inputSchema.parse(input)
    const hypotheses = await this.store.listHypothesesByProject(projectId)

    return {
      id: `list_hypotheses_${Date.now()}`,
      name: this.name,
      result: JSON.stringify(hypotheses, null, 2),
      metadata: { count: hypotheses.length, projectId },
    }
  }
}