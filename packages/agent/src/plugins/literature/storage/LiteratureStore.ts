import { randomUUID } from 'crypto'
import { literatureDb } from '../../../ipc/db-client.js'
import type {
  LiteratureSource,
  LiteratureSourceKind,
  EvidenceSpan,
  PaperCardRecord,
  PaperCard,
  SourceSearchOptions,
  EvidenceSearchOptions,
  Annotation,
} from '../types.js'

function deserializeSource(row: Record<string, unknown> | null | undefined): LiteratureSource | null {
  if (!row) return null
  return {
    id: row.id as string,
    kind: row.kind as LiteratureSourceKind,
    title: row.title as string,
    authors: JSON.parse((row.authors_json as string) || '[]'),
    year: row.year != null ? Number(row.year) : undefined,
    venue: (row.venue as string) || undefined,
    doi: (row.doi as string) || undefined,
    arxivId: (row.arxiv_id as string) || undefined,
    url: (row.url as string) || undefined,
    filePath: (row.file_path as string) || undefined,
    citationKey: (row.citation_key as string) || undefined,
    bibtex: (row.bibtex as string) || undefined,
    projectIds: JSON.parse((row.project_ids_json as string) || '[]'),
    tags: JSON.parse((row.tags_json as string) || '[]'),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function deserializeSpan(row: Record<string, unknown>): EvidenceSpan {
  return {
    id: row.id as string,
    sourceId: row.source_id as string,
    page: row.page != null ? Number(row.page) : undefined,
    section: (row.section as string) || undefined,
    text: row.text as string,
    quote: (row.quote as string) || undefined,
    bbox: row.bbox_json ? JSON.parse(row.bbox_json as string) : undefined,
    createdAt: Number(row.created_at),
  }
}

function deserializePaperCard(row: Record<string, unknown>): PaperCardRecord {
  return {
    id: row.id as string,
    sourceId: row.source_id as string,
    card: JSON.parse(row.card_json as string) as PaperCard,
    evidenceSpanIds: JSON.parse((row.evidence_span_ids_json as string) || '[]'),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

export class LiteratureStore {
  // ==================== Sources ====================

  async createSource(input: {
    kind: LiteratureSourceKind
    title: string
    authors: string[]
    year?: number
    venue?: string
    doi?: string
    arxivId?: string
    url?: string
    filePath?: string
    citationKey?: string
    bibtex?: string
    projectIds?: string[]
    tags?: string[]
  }): Promise<LiteratureSource> {
    const id = randomUUID()
    const row = await literatureDb.sourceCreate({
      id,
      ...input,
    })
    return deserializeSource(row as Record<string, unknown>)!
  }

  async getSource(id: string): Promise<LiteratureSource | null> {
    const row = await literatureDb.sourceGet(id)
    return deserializeSource(row as Record<string, unknown> | null)
  }

  async listSources(options?: SourceSearchOptions & { search?: string; limit?: number }): Promise<LiteratureSource[]> {
    const rows = await literatureDb.sourceList(options) as Array<Record<string, unknown>>
    return rows.map(deserializeSource).filter((s): s is LiteratureSource => s !== null)
  }

  async updateSource(id: string, data: Partial<LiteratureSource>): Promise<LiteratureSource | null> {
    const row = await literatureDb.sourceUpdate(id, data as Record<string, unknown>)
    return deserializeSource(row as Record<string, unknown> | null)
  }

  async deleteSource(id: string): Promise<boolean> {
    const result = await literatureDb.sourceDelete(id) as { success: boolean }
    return result.success
  }

  // ==================== Evidence Spans ====================

  async createSpans(spans: Array<{
    sourceId: string
    page?: number
    section?: string
    text: string
    quote?: string
    bbox?: { page: number; x: number; y: number; width: number; height: number }
  }>): Promise<EvidenceSpan[]> {
    const spansWithIds = spans.map((s) => ({ id: randomUUID(), ...s }))
    await literatureDb.evidenceCreateMany(spansWithIds)
    return spansWithIds.map((s) => ({
      id: s.id,
      sourceId: s.sourceId,
      page: s.page,
      section: s.section,
      text: s.text,
      quote: s.quote,
      bbox: s.bbox,
      createdAt: Date.now(),
    }))
  }

  async searchEvidence(query: string, options?: EvidenceSearchOptions): Promise<EvidenceSpan[]> {
    const rows = await literatureDb.evidenceSearch(query, options) as Array<Record<string, unknown>>
    return rows.map(deserializeSpan)
  }

  async deleteSpansBySource(sourceId: string): Promise<void> {
    await literatureDb.evidenceDeleteBySource(sourceId)
  }

  // ==================== Paper Cards ====================

  async upsertPaperCard(sourceId: string, card: PaperCard, evidenceSpanIds: string[]): Promise<PaperCardRecord> {
    const id = randomUUID()
    const row = await literatureDb.paperCardUpsert({
      id,
      sourceId,
      card: card as unknown as Record<string, unknown>,
      evidenceSpanIds,
    })
    return deserializePaperCard(row as Record<string, unknown>)
  }

  async getPaperCard(sourceId: string): Promise<PaperCardRecord | null> {
    const row = await literatureDb.paperCardGet(sourceId)
    if (!row) return null
    return deserializePaperCard(row as Record<string, unknown>)
  }

  async deletePaperCard(sourceId: string): Promise<boolean> {
    const result = await literatureDb.paperCardDelete(sourceId) as { success: boolean }
    return result.success
  }
}