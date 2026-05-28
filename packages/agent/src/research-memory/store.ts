import { randomUUID } from 'crypto'
import { researchMemoryDb } from '../ipc/db-client.js'
import type {
  ResearchProject,
  ProjectState,
  ResearchMemoryObject,
  ResearchHypothesis,
  ResearchMemoryCandidate,
  ResearchMemoryContext,
  ResearchMemoryRelation,
  AcceptCandidateResult,
  ResearchIntent,
  CandidateStatus,
} from './types.js'
import {
  deserializeEmbedding,
  serializeEmbedding,
  computeTFIDFVectorsForCorpus,
  computeTFIDFVector,
  searchByEmbedding,
} from './embedding.js'

function deserializeProject(row: Record<string, unknown>): ResearchProject {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) || undefined,
    status: row.status as ResearchProject['status'],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function deserializeProjectState(row: Record<string, unknown>): ProjectState {
  const state = JSON.parse((row.state_json as string) || '{}')
  return {
    projectId: row.project_id as string,
    currentQuestion: state.currentQuestion as string | undefined,
    activePhase: state.activePhase as string | undefined,
    unresolvedQuestions: (state.unresolvedQuestions as string[]) || [],
    keyDecisions: (state.keyDecisions as string[]) || [],
    state: state.state || {},
    updatedAt: Number(row.updated_at),
  }
}

function deserializeMemoryObject(row: Record<string, unknown>): ResearchMemoryObject {
  return {
    id: row.id as string,
    type: row.type as ResearchMemoryObject['type'],
    projectId: row.project_id as string,
    content: row.content as string,
    summary: (row.summary as string) || undefined,
    sourceRefs: JSON.parse((row.source_refs_json as string) || '[]'),
    relationRefs: JSON.parse((row.relation_refs_json as string) || '[]'),
    validFrom: row.valid_from != null ? Number(row.valid_from) : undefined,
    validTo: row.valid_to != null ? Number(row.valid_to) : undefined,
    status: row.status as ResearchMemoryObject['status'],
    confidence: Number(row.confidence),
    importance: Number(row.importance),
    tags: JSON.parse((row.tags_json as string) || '[]'),
    embedding: deserializeEmbedding(row.embedding_json as string | null | undefined),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function deserializeHypothesis(row: Record<string, unknown>): ResearchHypothesis {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    statement: row.statement as string,
    status: row.status as ResearchHypothesis['status'],
    supportingEvidenceIds: JSON.parse((row.supporting_evidence_ids_json as string) || '[]'),
    contradictingEvidenceIds: JSON.parse((row.contradicting_evidence_ids_json as string) || '[]'),
    relatedSourceIds: JSON.parse((row.related_source_ids_json as string) || '[]'),
    supersededBy: (row.superseded_by as string) || undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function deserializeCandidate(row: Record<string, unknown>): ResearchMemoryCandidate {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    proposedType: row.proposed_type as ResearchMemoryCandidate['proposedType'],
    content: row.content as string,
    rationale: row.rationale as string,
    sourceRefs: JSON.parse((row.source_refs_json as string) || '[]'),
    confidence: Number(row.confidence),
    status: row.status as CandidateStatus,
    createdBySessionId: (row.created_by_session_id as string) || undefined,
    createdAt: Number(row.created_at),
    reviewedAt: row.reviewed_at != null ? Number(row.reviewed_at) : undefined,
  }
}

function deserializeRelation(row: Record<string, unknown>): ResearchMemoryRelation {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    fromMemoryId: row.from_memory_id as string,
    toMemoryId: row.to_memory_id as string,
    relationType: row.relation_type as string,
    createdAt: Number(row.created_at),
  }
}

const AUTO_ACCEPT_CONFIDENCE_THRESHOLD = 0.85
const AUTO_ACCEPT_TYPES: ReadonlySet<string> = new Set(['claim', 'decision'])
const AUTO_REJECT_CONFIDENCE_THRESHOLD = 0.6
const AUTO_REJECT_TYPES: ReadonlySet<string> = new Set(['hypothesis'])

export class ResearchMemoryStore {
  // ==================== Projects ====================

  async createProject(name: string, description?: string): Promise<ResearchProject> {
    const id = randomUUID()
    const row = await researchMemoryDb.projectCreate({ id, name, description })
    return deserializeProject(row as Record<string, unknown>)
  }

  async getProject(id: string): Promise<ResearchProject | null> {
    const row = await researchMemoryDb.projectGet(id)
    if (!row) return null
    return deserializeProject(row as Record<string, unknown>)
  }

  async listProjects(): Promise<ResearchProject[]> {
    const rows = await researchMemoryDb.projectList() as Array<Record<string, unknown>>
    return rows.map(deserializeProject)
  }

  async listActiveProjects(): Promise<ResearchProject[]> {
    const all = await this.listProjects()
    return all.filter((p) => p.status === 'active')
  }

  async updateProject(id: string, data: Partial<Pick<ResearchProject, 'name' | 'description' | 'status'>>): Promise<ResearchProject | null> {
    const row = await researchMemoryDb.projectUpdate(id, data as Record<string, unknown>)
    if (!row) return null
    return deserializeProject(row as Record<string, unknown>)
  }

  async deleteProject(id: string): Promise<boolean> {
    const result = await researchMemoryDb.projectDelete(id) as { success: boolean }
    return result.success
  }

  // ==================== Project State ====================

  async getProjectState(projectId: string): Promise<ProjectState | null> {
    const row = await researchMemoryDb.projectStateGet(projectId)
    if (!row) return null
    return deserializeProjectState(row as Record<string, unknown>)
  }

  async upsertProjectState(projectId: string, state: {
    currentQuestion?: string
    activePhase?: string
    unresolvedQuestions?: string[]
    keyDecisions?: string[]
    state?: Record<string, unknown>
  }): Promise<ProjectState> {
    const fullState: Record<string, unknown> = {
      currentQuestion: state.currentQuestion,
      activePhase: state.activePhase,
      unresolvedQuestions: state.unresolvedQuestions || [],
      keyDecisions: state.keyDecisions || [],
      state: state.state || {},
    }
    const row = await researchMemoryDb.projectStateUpsert(projectId, fullState)
    return deserializeProjectState(row as Record<string, unknown>)
  }

  // ==================== Memory Objects ====================

  async createMemoryObject(data: {
    projectId: string
    type: ResearchMemoryObject['type']
    content: string
    summary?: string
    sourceRefs?: ResearchMemoryObject['sourceRefs']
    relationRefs?: ResearchMemoryObject['relationRefs']
    validFrom?: number
    validTo?: number
    status?: ResearchMemoryObject['status']
    confidence?: number
    importance?: number
    tags?: string[]
    embedding?: number[]
  }): Promise<ResearchMemoryObject> {
    const id = randomUUID()
    const row = await researchMemoryDb.memoryObjectCreate({
      id,
      projectId: data.projectId,
      type: data.type,
      content: data.content,
      summary: data.summary,
      sourceRefs: data.sourceRefs,
      relationRefs: data.relationRefs,
      validFrom: data.validFrom,
      validTo: data.validTo,
      status: data.status,
      confidence: data.confidence,
      importance: data.importance,
      tags: data.tags,
      ...(data.embedding ? { embedding_json: serializeEmbedding(data.embedding) } : {}),
    } as Parameters<typeof researchMemoryDb.memoryObjectCreate>[0])
    return deserializeMemoryObject(row as Record<string, unknown>)
  }

  async getMemoryObject(id: string): Promise<ResearchMemoryObject | null> {
    const row = await researchMemoryDb.memoryObjectGet(id)
    if (!row) return null
    return deserializeMemoryObject(row as Record<string, unknown>)
  }

  async listMemoryObjectsByProject(projectId: string, options?: {
    type?: string
    status?: string
    limit?: number
  }): Promise<ResearchMemoryObject[]> {
    const rows = await researchMemoryDb.memoryObjectListByProject(projectId, options) as Array<Record<string, unknown>>
    return rows.map(deserializeMemoryObject)
  }

  async searchMemoryObjects(query: string, projectId?: string, options?: {
    type?: string
    status?: string
    limit?: number
  }): Promise<ResearchMemoryObject[]> {
    const rows = await researchMemoryDb.memoryObjectSearch(query, projectId, options) as Array<Record<string, unknown>>
    return rows.map(deserializeMemoryObject)
  }

  async updateMemoryObject(id: string, data: Partial<ResearchMemoryObject>): Promise<ResearchMemoryObject | null> {
    const row = await researchMemoryDb.memoryObjectUpdate(id, data as Record<string, unknown>)
    if (!row) return null
    return deserializeMemoryObject(row as Record<string, unknown>)
  }

  async deleteMemoryObject(id: string): Promise<boolean> {
    const result = await researchMemoryDb.memoryObjectDelete(id) as { success: boolean }
    return result.success
  }

  // ==================== Embeddings ====================

  async updateEmbedding(id: string, embedding: number[] | null): Promise<ResearchMemoryObject> {
    const embeddingJson = embedding ? serializeEmbedding(embedding) : null
    const row = await researchMemoryDb.objectUpdateEmbedding(id, embeddingJson)
    return deserializeMemoryObject(row as Record<string, unknown>)
  }

  async listWithEmbeddings(projectId?: string): Promise<Array<{ id: string; projectId: string; content: string; embedding: number[] }>> {
    const rows = await researchMemoryDb.objectListWithEmbeddings(projectId, 500) as Array<{
      id: string
      project_id: string
      content: string
      embedding_json: string
    }>
    return rows
      .map((r) => {
        const embedding = deserializeEmbedding(r.embedding_json)
        if (!embedding) return null
        return {
          id: r.id,
          projectId: r.project_id,
          content: r.content,
          embedding,
        }
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
  }

  async semanticSearch(
    query: string,
    projectId?: string,
    topK: number = 10,
    minSimilarity: number = 0.3,
  ): Promise<Array<{ memory: ResearchMemoryObject; similarity: number }>> {
    const candidates = await this.listWithEmbeddings(projectId)
    if (candidates.length === 0) return []

    const corpusTexts = candidates.map((c) => c.content)
    const queryEmbedding = computeTFIDFVector(query, corpusTexts)

    const ranked = searchByEmbedding(queryEmbedding, candidates, topK, minSimilarity)

    const results: Array<{ memory: ResearchMemoryObject; similarity: number }> = []
    for (const r of ranked) {
      const memory = await this.getMemoryObject(r.id)
      if (memory) {
        results.push({ memory, similarity: r.similarity })
      }
    }
    return results
  }

  async buildEmbeddingsForProject(projectId: string): Promise<number> {
    const memories = await this.listMemoryObjectsByProject(projectId, { limit: 500 })
    if (memories.length === 0) return 0

    const texts = memories.map((m) => m.content)
    const vectors = computeTFIDFVectorsForCorpus(texts)

    let count = 0
    for (let i = 0; i < memories.length; i++) {
      if (vectors[i] && vectors[i].length > 0) {
        await this.updateEmbedding(memories[i].id, vectors[i])
        count++
      }
    }
    return count
  }

  // ==================== Hypotheses ====================

  async createHypothesis(data: {
    projectId: string
    statement: string
    status?: string
    supportingEvidenceIds?: string[]
    contradictingEvidenceIds?: string[]
    relatedSourceIds?: string[]
  }): Promise<ResearchHypothesis> {
    const id = randomUUID()
    const row = await researchMemoryDb.hypothesisCreate({ id, ...data })
    return deserializeHypothesis(row as Record<string, unknown>)
  }

  async getHypothesis(id: string): Promise<ResearchHypothesis | null> {
    const row = await researchMemoryDb.hypothesisGet(id)
    if (!row) return null
    return deserializeHypothesis(row as Record<string, unknown>)
  }

  async listHypothesesByProject(projectId: string): Promise<ResearchHypothesis[]> {
    const rows = await researchMemoryDb.hypothesisListByProject(projectId) as Array<Record<string, unknown>>
    return rows.map(deserializeHypothesis)
  }

  async updateHypothesis(id: string, data: {
    status?: string
    supersededBy?: string
    supportingEvidenceIds?: string[]
    contradictingEvidenceIds?: string[]
    relatedSourceIds?: string[]
  }): Promise<ResearchHypothesis | null> {
    const row = await researchMemoryDb.hypothesisUpdate(id, data)
    if (!row) return null
    return deserializeHypothesis(row as Record<string, unknown>)
  }

  async deleteHypothesis(id: string): Promise<boolean> {
    const result = await researchMemoryDb.hypothesisDelete(id) as { success: boolean }
    return result.success
  }

  // ==================== Candidates ====================

  async createCandidate(data: {
    projectId: string
    proposedType: ResearchMemoryCandidate['proposedType']
    content: string
    rationale: string
    sourceRefs?: ResearchMemoryCandidate['sourceRefs']
    confidence?: number
    createdBySessionId?: string
  }): Promise<ResearchMemoryCandidate> {
    const id = randomUUID()
    const row = await researchMemoryDb.candidateCreate({ id, ...data })
    return deserializeCandidate(row as Record<string, unknown>)
  }

  async listCandidatesByProject(projectId: string, status?: CandidateStatus): Promise<ResearchMemoryCandidate[]> {
    const rows = await researchMemoryDb.candidateListByProject(projectId, status) as Array<Record<string, unknown>>
    return rows.map(deserializeCandidate)
  }

  async getCandidate(id: string): Promise<ResearchMemoryCandidate | null> {
    const row = await researchMemoryDb.candidateGet(id)
    if (!row) return null
    return deserializeCandidate(row as Record<string, unknown>)
  }

  async acceptCandidate(id: string, embedding?: number[]): Promise<AcceptCandidateResult> {
    const options: Record<string, unknown> = {}
    if (embedding) {
      options.embedding_json = serializeEmbedding(embedding)
    }
    const row = await researchMemoryDb.candidateAccept(id, options) as {
      candidate: Record<string, unknown>
      memory: Record<string, unknown>
    }

    return {
      candidate: deserializeCandidate(row.candidate),
      memory: deserializeMemoryObject(row.memory),
    }
  }

  async rejectCandidate(id: string): Promise<ResearchMemoryCandidate> {
    const row = await researchMemoryDb.candidateReject(id)
    return deserializeCandidate(row as Record<string, unknown>)
  }

  async deleteCandidate(id: string): Promise<boolean> {
    const result = await researchMemoryDb.candidateDelete(id) as { success: boolean }
    return result.success
  }

  // ==================== Auto-Review ====================

  shouldAutoAccept(candidate: ResearchMemoryCandidate): boolean {
    if (candidate.status !== 'pending') return false
    if (candidate.confidence < AUTO_ACCEPT_CONFIDENCE_THRESHOLD) return false
    return AUTO_ACCEPT_TYPES.has(candidate.proposedType)
  }

  shouldAutoReject(candidate: ResearchMemoryCandidate): boolean {
    if (candidate.status !== 'pending') return false
    if (candidate.confidence < AUTO_REJECT_CONFIDENCE_THRESHOLD) return false
    return AUTO_REJECT_TYPES.has(candidate.proposedType)
  }

  applyAutoReview(candidate: ResearchMemoryCandidate): 'auto_accept' | 'auto_reject' | 'manual' {
    if (this.shouldAutoAccept(candidate)) return 'auto_accept'
    if (this.shouldAutoReject(candidate)) return 'auto_reject'
    return 'manual'
  }

  // ==================== Relations ====================

  async createRelation(data: {
    projectId: string
    fromMemoryId: string
    toMemoryId: string
    relationType: string
  }): Promise<ResearchMemoryRelation> {
    const row = await researchMemoryDb.relationCreate(data)
    return deserializeRelation(row as Record<string, unknown>)
  }

  async listRelationsByMemory(memoryId: string): Promise<ResearchMemoryRelation[]> {
    const rows = await researchMemoryDb.relationListByMemory(memoryId) as Array<Record<string, unknown>>
    return rows.map(deserializeRelation)
  }

  async listRelationsByProject(projectId: string): Promise<ResearchMemoryRelation[]> {
    const rows = await researchMemoryDb.relationListByProject(projectId) as Array<Record<string, unknown>>
    return rows.map(deserializeRelation)
  }

  async deleteRelation(id: string): Promise<boolean> {
    const result = await researchMemoryDb.relationDelete(id) as { success: boolean }
    return result.success
  }

  async getGraphNeighbors(
    memoryId: string,
    depth: number = 1,
    visited: Set<string> = new Set(),
  ): Promise<ResearchMemoryObject[]> {
    if (depth <= 0 || visited.has(memoryId)) return []
    visited.add(memoryId)

    const relations = await this.listRelationsByMemory(memoryId)
    const neighborIds = new Set<string>()
    for (const rel of relations) {
      if (rel.fromMemoryId !== memoryId) neighborIds.add(rel.fromMemoryId)
      if (rel.toMemoryId !== memoryId) neighborIds.add(rel.toMemoryId)
    }

    const memories: ResearchMemoryObject[] = []
    for (const neighborId of neighborIds) {
      const memory = await this.getMemoryObject(neighborId)
      if (memory) {
        memories.push(memory)
      }
    }

    if (depth > 1) {
      for (const neighborId of neighborIds) {
        const deeper = await this.getGraphNeighbors(neighborId, depth - 1, visited)
        for (const m of deeper) {
          if (!memories.find((existing) => existing.id === m.id)) {
            memories.push(m)
          }
        }
      }
    }

    return memories
  }

  // ==================== Retrieval ====================

  async retrieveForIntent(
    intent: ResearchIntent,
    query: string,
    projectId?: string,
    options?: {
      crossProjectSearch?: boolean
      enableSemanticSearch?: boolean
    },
  ): Promise<ResearchMemoryContext> {
    const { crossProjectSearch = false, enableSemanticSearch = true } = options ?? {}

    const context: ResearchMemoryContext = {
      projectState: null,
      activeHypotheses: [],
      recentMemories: [],
      relatedMemories: [],
      relatedByGraph: [],
      rejectedDirections: [],
      crossProjectMemories: [],
    }

    if (projectId) {
      context.projectState = await this.getProjectState(projectId)

      const hypotheses = await this.listHypothesesByProject(projectId)
      context.activeHypotheses = hypotheses.filter(
        (h) => !['rejected', 'published'].includes(h.status),
      )

      context.recentMemories = await this.listMemoryObjectsByProject(projectId, { limit: 20 })

      context.rejectedDirections = await this.listMemoryObjectsByProject(projectId, {
        type: 'decision',
        status: 'deprecated',
        limit: 10,
      })
    }

    if (query) {
      const keywordResults = await this.searchMemoryObjects(query, projectId, { limit: 10 })
      const keywordIds = new Set(keywordResults.map((r) => r.id))

      const merged: ResearchMemoryObject[] = [...keywordResults]

      if (enableSemanticSearch) {
        const semanticResults = await this.semanticSearch(query, projectId, 10, 0.3)
        for (const sr of semanticResults) {
          if (!keywordIds.has(sr.memory.id)) {
            merged.push(sr.memory)
            keywordIds.add(sr.memory.id)
          }
        }
      }

      context.relatedMemories = merged.slice(0, 20)

      const graphNeighbors: ResearchMemoryObject[] = []
      const seenGraphIds = new Set(keywordIds)
      for (const memory of context.relatedMemories.slice(0, 5)) {
        const neighbors = await this.getGraphNeighbors(memory.id, 1)
        for (const n of neighbors) {
          if (!seenGraphIds.has(n.id)) {
            graphNeighbors.push(n)
            seenGraphIds.add(n.id)
          }
        }
      }
      context.relatedByGraph = graphNeighbors.slice(0, 10)
    }

    if (crossProjectSearch && query) {
      const activeProjects = await this.listActiveProjects()
      const otherProjects = activeProjects.filter((p) => p.id !== projectId)

      if (otherProjects.length > 0) {
        const crossResults: ResearchMemoryObject[] = []
        for (const otherProject of otherProjects.slice(0, 5)) {
          if (enableSemanticSearch) {
            const semanticResults = await this.semanticSearch(query, otherProject.id, 3, 0.35)
            for (const sr of semanticResults) {
              crossResults.push(sr.memory)
            }
          }
          const keywordResults = await this.searchMemoryObjects(query, otherProject.id, {
            type: 'feedback',
            limit: 3,
          })
          for (const kr of keywordResults) {
            if (!crossResults.find((r) => r.id === kr.id)) {
              crossResults.push(kr)
            }
          }
        }
        context.crossProjectMemories = crossResults.slice(0, 10)
      }
    }

    return context
  }
}