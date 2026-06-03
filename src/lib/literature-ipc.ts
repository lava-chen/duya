import type {
  LiteratureDocumentChunk,
  LiteratureEvidenceSummary,
  LiteratureCitationStyle,
  LiteraturePaperCardSummary,
  LiteratureSourceSummary,
} from '../../electron/preload';

export async function ingestParsedLiteratureDocument(input: {
  filePath: string;
  parseResult: Parameters<typeof window.electronAPI.literature.ingestParsedDocument>[0]['parseResult'];
}): Promise<{ action: 'created' | 'updated'; source: LiteratureSourceSummary }> {
  return window.electronAPI.literature.ingestParsedDocument(input);
}

export async function listLiteratureSources(): Promise<LiteratureSourceSummary[]> {
  return window.electronAPI.literature.listSources();
}

export async function getLiteratureSource(sourceId: string): Promise<LiteratureSourceSummary | null> {
  return window.electronAPI.literature.getSource(sourceId);
}

export async function listLiteratureChunks(sourceId: string, limit = 20): Promise<LiteratureDocumentChunk[]> {
  return window.electronAPI.literature.listChunks(sourceId, limit);
}

export async function getLiteraturePaperCard(sourceId: string): Promise<LiteraturePaperCardSummary | null> {
  return window.electronAPI.literature.getPaperCard(sourceId);
}

export async function listLiteratureEvidence(sourceId: string): Promise<LiteratureEvidenceSummary[]> {
  return window.electronAPI.literature.listEvidence(sourceId);
}

export async function saveLiteratureEvidence(input: {
  sourceId: string
  chunkId?: string
  chunkIndex?: number
  pageNumber?: number | null
  sectionLabel?: string | null
  text: string
  quote: string
}): Promise<{ action: 'created' | 'existing'; evidence: LiteratureEvidenceSummary }> {
  return window.electronAPI.literature.saveEvidence(input);
}

export async function getLiteratureCitation(
  sourceId: string,
  style: LiteratureCitationStyle,
): Promise<string> {
  return window.electronAPI.literature.getCitation(sourceId, style);
}
