import { ResearchMemoryStore } from './store.js'
import { RetrieveResearchMemoryTool } from './tools/RetrieveResearchMemoryTool.js'
import { ProposeResearchMemoryTool } from './tools/ProposeResearchMemoryTool.js'
import { ListCandidatesTool } from './tools/ListCandidatesTool.js'
import { AcceptCandidateTool } from './tools/AcceptCandidateTool.js'
import { ListHypothesesTool } from './tools/ListHypothesesTool.js'
import { UpdateHypothesisTool } from './tools/UpdateHypothesisTool.js'
import { ManageRelationsTool } from './tools/ManageRelationsTool.js'
import type { BaseTool } from '../tool/BaseTool.js'
import type {
  ResearchMemoryRuntime,
  ResearchMemoryContext,
  ResearchIntent,
  ResearchProject,
  ProjectState,
  ResearchHypothesis,
  ResearchMemoryCandidate,
  ResearchMemoryRelation,
  AcceptCandidateResult,
  CandidateStatus,
} from './types.js'

export class ResearchMemory implements ResearchMemoryRuntime {
  private store: ResearchMemoryStore

  readonly retrieveTool: RetrieveResearchMemoryTool
  readonly proposeTool: ProposeResearchMemoryTool
  readonly listCandidatesTool: ListCandidatesTool
  readonly acceptCandidateTool: AcceptCandidateTool
  readonly listHypothesesTool: ListHypothesesTool
  readonly updateHypothesisTool: UpdateHypothesisTool
  readonly manageRelationsTool: ManageRelationsTool

  constructor() {
    this.store = new ResearchMemoryStore()
    this.retrieveTool = new RetrieveResearchMemoryTool(this.store)
    this.proposeTool = new ProposeResearchMemoryTool(this.store)
    this.listCandidatesTool = new ListCandidatesTool(this.store)
    this.acceptCandidateTool = new AcceptCandidateTool(this.store)
    this.listHypothesesTool = new ListHypothesesTool(this.store)
    this.updateHypothesisTool = new UpdateHypothesisTool(this.store)
    this.manageRelationsTool = new ManageRelationsTool(this.store)
  }

  get tools(): BaseTool[] {
    return [
      this.retrieveTool,
      this.proposeTool,
      this.listCandidatesTool,
      this.acceptCandidateTool,
      this.listHypothesesTool,
      this.updateHypothesisTool,
      this.manageRelationsTool,
    ]
  }

  async getProjectState(projectId: string): Promise<ProjectState | null> {
    return this.store.getProjectState(projectId)
  }

  async retrieveForIntent(
    intent: ResearchIntent,
    query: string,
    projectId?: string,
    options?: {
      crossProjectSearch?: boolean
      enableSemanticSearch?: boolean
    },
  ): Promise<ResearchMemoryContext> {
    return this.store.retrieveForIntent(intent, query, projectId, options)
  }

  async proposeMemoryCandidates(
    candidates: Array<Omit<ResearchMemoryCandidate, 'id' | 'status' | 'createdAt' | 'reviewedAt'>>,
  ): Promise<ResearchMemoryCandidate[]> {
    const created: ResearchMemoryCandidate[] = []
    for (const c of candidates) {
      const candidate = await this.store.createCandidate({
        projectId: c.projectId,
        proposedType: c.proposedType,
        content: c.content,
        rationale: c.rationale,
        sourceRefs: c.sourceRefs,
        confidence: c.confidence,
        createdBySessionId: c.createdBySessionId,
      })
      created.push(candidate)
    }
    return created
  }

  async listCandidates(projectId: string, status?: CandidateStatus): Promise<ResearchMemoryCandidate[]> {
    return this.store.listCandidatesByProject(projectId, status)
  }

  async acceptCandidate(
    candidateId: string,
    autoReview?: boolean,
  ): Promise<AcceptCandidateResult | null> {
    if (autoReview) {
      const candidates = await this.store.listCandidatesByProject(undefined as unknown as string)
      // Fetch specific candidate for auto-review
      // Since listCandidatesByProject requires projectId, we fetch via a different approach
      // The auto-review is primarily driven by the tool layer
      return this.store.acceptCandidate(candidateId)
    }
    return this.store.acceptCandidate(candidateId)
  }

  async rejectCandidate(candidateId: string): Promise<void> {
    await this.store.rejectCandidate(candidateId)
  }

  async listHypotheses(projectId: string): Promise<ResearchHypothesis[]> {
    return this.store.listHypothesesByProject(projectId)
  }

  async updateHypothesis(
    id: string,
    update: Partial<Pick<ResearchHypothesis, 'status' | 'supersededBy'>>,
  ): Promise<ResearchHypothesis> {
    const result = await this.store.updateHypothesis(id, update)
    if (!result) throw new Error(`Hypothesis not found: ${id}`)
    return result
  }

  async listProjects(): Promise<ResearchProject[]> {
    return this.store.listProjects()
  }

  async createProject(name: string, description?: string): Promise<ResearchProject> {
    return this.store.createProject(name, description)
  }

  async createRelation(data: {
    projectId: string
    fromMemoryId: string
    toMemoryId: string
    relationType: string
  }): Promise<ResearchMemoryRelation> {
    return this.store.createRelation(data)
  }

  async listRelationsByMemory(memoryId: string): Promise<ResearchMemoryRelation[]> {
    return this.store.listRelationsByMemory(memoryId)
  }

  async listRelationsByProject(projectId: string): Promise<ResearchMemoryRelation[]> {
    return this.store.listRelationsByProject(projectId)
  }

  async deleteRelation(id: string): Promise<boolean> {
    return this.store.deleteRelation(id)
  }

  async buildEmbeddingsForProject(projectId: string): Promise<number> {
    return this.store.buildEmbeddingsForProject(projectId)
  }
}

export { ResearchMemoryStore } from './store.js'
export * from './types.js'