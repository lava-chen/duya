import { z } from 'zod'
import { BaseTool } from '../../tool/BaseTool.js'
import type { ToolResult } from '../../tool/types.js'
import type { ToolUseContext } from '../../types.js'
import type { ResearchMemoryStore } from '../store.js'
import type { ResearchIntent } from '../types.js'

const inputSchema = z.object({
  intent: z.enum(['paper_qa', 'literature_review', 'project_planning', 'hypothesis_check', 'experiment_planning', 'writing', 'advisor_feedback']),
  query: z.string().min(1),
  projectId: z.string().optional(),
  crossProjectSearch: z.boolean().default(false),
  enableSemanticSearch: z.boolean().default(true),
})

export class RetrieveResearchMemoryTool extends BaseTool {
  readonly name = 'research_memory:retrieve'
  readonly description = 'Retrieve research memory context for a specific research intent. Use for project planning, hypothesis checking, literature review, and writing. Set crossProjectSearch=true to search across all active projects. Set enableSemanticSearch=false to disable vector similarity search (fallback to keyword only).'
  readonly input_schema = inputSchema

  private store: ResearchMemoryStore

  constructor(store: ResearchMemoryStore) {
    super()
    this.store = store
  }

  async execute(input: Record<string, unknown>, _workingDirectory?: string, _context?: ToolUseContext): Promise<ToolResult> {
    const { intent, query, projectId, crossProjectSearch, enableSemanticSearch } = inputSchema.parse(input)
    const context = await this.store.retrieveForIntent(
      intent as ResearchIntent,
      query,
      projectId,
      { crossProjectSearch, enableSemanticSearch },
    )

    return {
      id: `retrieve_${Date.now()}`,
      name: this.name,
      result: JSON.stringify(context, null, 2),
      metadata: {
        intent,
        enableSemanticSearch,
        hypothesesCount: context.activeHypotheses.length,
        memoriesCount: context.recentMemories.length,
        relatedCount: context.relatedMemories.length,
        graphRelatedCount: context.relatedByGraph.length,
        crossProjectCount: context.crossProjectMemories.length,
        hasProjectState: !!context.projectState,
      },
    }
  }
}