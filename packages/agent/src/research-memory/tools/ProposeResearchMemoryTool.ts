import { z } from 'zod'
import { BaseTool } from '../../tool/BaseTool.js'
import type { ToolResult } from '../../tool/types.js'
import type { ToolUseContext } from '../../types.js'
import type { ResearchMemoryStore } from '../store.js'
import type { ResearchMemoryCandidate, ResearchMemoryType } from '../types.js'

const inputSchema = z.object({
  projectId: z.string().min(1),
  candidates: z.array(z.object({
    proposedType: z.enum(['project_state', 'hypothesis', 'decision', 'experiment', 'feedback', 'writing_decision', 'todo', 'claim']),
    content: z.string().min(1),
    rationale: z.string().min(1),
    sourceRefs: z.array(z.object({
      kind: z.enum(['literature', 'chat', 'experiment', 'manual', 'file']),
      sourceId: z.string().optional(),
      evidenceSpanId: z.string().optional(),
      sessionId: z.string().optional(),
      messageId: z.string().optional(),
      filePath: z.string().optional(),
    })).default([]),
    confidence: z.number().min(0).max(1).default(0.7),
  })),
  sessionId: z.string().optional(),
})

export class ProposeResearchMemoryTool extends BaseTool {
  readonly name = 'research_memory:propose'
  readonly description = 'Propose research memory candidates for review. Candidates will NOT become durable memory until accepted via the review queue.'
  readonly input_schema = inputSchema

  private store: ResearchMemoryStore

  constructor(store: ResearchMemoryStore) {
    super()
    this.store = store
  }

  async execute(input: Record<string, unknown>, _workingDirectory?: string, _context?: ToolUseContext): Promise<ToolResult> {
    const { projectId, candidates, sessionId } = inputSchema.parse(input)

    const created: ResearchMemoryCandidate[] = []
    for (const c of candidates) {
      const candidate = await this.store.createCandidate({
        projectId,
        proposedType: c.proposedType as ResearchMemoryType,
        content: c.content,
        rationale: c.rationale,
        sourceRefs: c.sourceRefs,
        confidence: c.confidence,
        createdBySessionId: sessionId,
      })
      created.push(candidate)
    }

    return {
      id: `propose_${Date.now()}`,
      name: this.name,
      result: JSON.stringify({
        message: `${created.length} memory candidate(s) proposed for review. They will not become durable memory until accepted.`,
        candidates: created.map((c) => ({ id: c.id, type: c.proposedType, status: c.status })),
      }, null, 2),
      metadata: { count: created.length, candidateIds: created.map((c) => c.id) },
    }
  }
}