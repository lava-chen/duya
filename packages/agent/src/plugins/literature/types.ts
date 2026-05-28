export type LiteratureSourceKind =
  | 'paper'
  | 'book'
  | 'webpage'
  | 'report'
  | 'thesis'
  | 'dataset'

export interface LiteratureSource {
  id: string
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
  projectIds: string[]
  tags: string[]
  createdAt: number
  updatedAt: number
}

export interface EvidenceSpan {
  id: string
  sourceId: string
  page?: number
  section?: string
  text: string
  quote?: string
  bbox?: {
    page: number
    x: number
    y: number
    width: number
    height: number
  }
  createdAt: number
}

export interface PaperCard {
  researchProblem: string
  methodSummary: string
  datasets: string[]
  metrics: string[]
  keyFindings: string[]
  limitations: string[]
  reusableIdeas: string[]
}

export interface PaperCardRecord {
  id: string
  sourceId: string
  card: PaperCard
  evidenceSpanIds: string[]
  createdAt: number
  updatedAt: number
}

export interface SourceSearchOptions {
  kind?: LiteratureSourceKind
  projectId?: string
  tags?: string[]
  yearFrom?: number
  yearTo?: number
}

export interface EvidenceSearchOptions {
  sourceId?: string
  page?: number
  section?: string
}

export interface Annotation {
  id: string
  sourceId: string
  evidenceSpanId?: string
  content: string
  tags: string[]
  createdAt: number
  updatedAt: number
}

export interface LiteraturePluginRuntime {
  addSource(input: AddSourceInput): Promise<LiteratureSource>
  searchSources(query: string, options?: SourceSearchOptions): Promise<LiteratureSource[]>
  searchEvidence(query: string, options?: EvidenceSearchOptions): Promise<EvidenceSpan[]>
  getCitation(sourceId: string, style: 'bibtex' | 'apa' | 'gbt7714'): Promise<string>
  extractPaperCard(sourceId: string): Promise<PaperCardRecord>
}

export interface AddSourceInput {
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
}