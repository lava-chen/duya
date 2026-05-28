export type ResearchMemoryType =
  | 'project_state'
  | 'hypothesis'
  | 'decision'
  | 'experiment'
  | 'feedback'
  | 'writing_decision'
  | 'todo'
  | 'claim'

export type ResearchMemoryStatus =
  | 'active'
  | 'tentative'
  | 'deprecated'
  | 'archived'

export type HypothesisStatus =
  | 'proposed'
  | 'supported'
  | 'weakened'
  | 'rejected'
  | 'accepted'
  | 'published'

export type CandidateStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'merged'

export type ProjectStatus = 'active' | 'paused' | 'completed' | 'archived'

export type ResearchIntent =
  | 'paper_qa'
  | 'literature_review'
  | 'project_planning'
  | 'hypothesis_check'
  | 'experiment_planning'
  | 'writing'
  | 'advisor_feedback'

export interface ResearchSourceRef {
  kind: 'literature' | 'chat' | 'experiment' | 'manual' | 'file'
  sourceId?: string
  evidenceSpanId?: string
  sessionId?: string
  messageId?: string
  filePath?: string
}

export interface ResearchRelationRef {
  memoryId: string
  relationType: string
}

export interface ResearchMemoryObject {
  id: string
  type: ResearchMemoryType
  projectId: string
  content: string
  summary?: string
  sourceRefs: ResearchSourceRef[]
  relationRefs: ResearchRelationRef[]
  validFrom?: number
  validTo?: number
  status: ResearchMemoryStatus
  confidence: number
  importance: number
  tags: string[]
  embedding?: number[]
  createdAt: number
  updatedAt: number
}

export interface ResearchHypothesis {
  id: string
  projectId: string
  statement: string
  status: HypothesisStatus
  supportingEvidenceIds: string[]
  contradictingEvidenceIds: string[]
  relatedSourceIds: string[]
  supersededBy?: string
  createdAt: number
  updatedAt: number
}

export interface ResearchMemoryCandidate {
  id: string
  projectId: string
  proposedType: ResearchMemoryType
  content: string
  rationale: string
  sourceRefs: ResearchSourceRef[]
  confidence: number
  status: CandidateStatus
  createdBySessionId?: string
  createdAt: number
  reviewedAt?: number
}

export interface ResearchProject {
  id: string
  name: string
  description?: string
  status: ProjectStatus
  createdAt: number
  updatedAt: number
}

export interface ProjectState {
  projectId: string
  currentQuestion?: string
  activePhase?: string
  unresolvedQuestions: string[]
  keyDecisions: string[]
  state: Record<string, unknown>
  updatedAt: number
}

export interface ResearchMemoryRelation {
  id: string
  projectId: string
  fromMemoryId: string
  toMemoryId: string
  relationType: string
  createdAt: number
}

export interface AcceptCandidateResult {
  candidate: ResearchMemoryCandidate
  memory: ResearchMemoryObject
}

export interface ResearchMemoryContext {
  projectState: ProjectState | null
  activeHypotheses: ResearchHypothesis[]
  recentMemories: ResearchMemoryObject[]
  relatedMemories: ResearchMemoryObject[]
  relatedByGraph: ResearchMemoryObject[]
  rejectedDirections: ResearchMemoryObject[]
  crossProjectMemories: ResearchMemoryObject[]
}

export interface ResearchMemoryRuntime {
  getProjectState(projectId: string): Promise<ProjectState | null>
  retrieveForIntent(
    intent: ResearchIntent,
    query: string,
    projectId?: string,
    options?: {
      crossProjectSearch?: boolean
      enableSemanticSearch?: boolean
    },
  ): Promise<ResearchMemoryContext>
  proposeMemoryCandidates(candidates: Omit<ResearchMemoryCandidate, 'id' | 'status' | 'createdAt'>[]): Promise<ResearchMemoryCandidate[]>
  listCandidates(projectId: string, status?: CandidateStatus): Promise<ResearchMemoryCandidate[]>
  acceptCandidate(candidateId: string, autoReview?: boolean): Promise<AcceptCandidateResult | null>
  rejectCandidate(candidateId: string): Promise<void>
  listHypotheses(projectId: string): Promise<ResearchHypothesis[]>
  updateHypothesis(id: string, update: Partial<Pick<ResearchHypothesis, 'status' | 'supersededBy'>>): Promise<ResearchHypothesis>
  listProjects(): Promise<ResearchProject[]>
  createProject(name: string, description?: string): Promise<ResearchProject>
  createRelation(data: { projectId: string; fromMemoryId: string; toMemoryId: string; relationType: string }): Promise<ResearchMemoryRelation>
  listRelationsByMemory(memoryId: string): Promise<ResearchMemoryRelation[]>
  listRelationsByProject(projectId: string): Promise<ResearchMemoryRelation[]>
  deleteRelation(id: string): Promise<boolean>
}