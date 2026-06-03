export interface SourceRow {
  id: string;
  kind: string;
  title: string;
  authors_json: string;
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxiv_id: string | null;
  url: string | null;
  file_path: string | null;
  file_hash: string | null;
  citation_key: string | null;
  bibtex: string | null;
  project_ids_json: string;
  tags_json: string;
  parse_status: string | null;
  parse_error: string | null;
  parse_metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface ChunkRow {
  id: string;
  source_id: string;
  chunk_index: number;
  page_number: number | null;
  section_label: string | null;
  text: string;
  char_count: number | null;
  created_at: number;
}

export interface PaperCardRow {
  id: string;
  source_id: string;
  card_json: string;
  evidence_span_ids_json: string;
  created_at: number;
  updated_at: number;
}

export interface PaperCard {
  researchProblem: string;
  methodSummary: string;
  datasets: string[];
  metrics: string[];
  keyFindings: string[];
  limitations: string[];
  reusableIdeas: string[];
  analysisMeta?: {
    scope: "partial_context" | "full_context";
    truncated: boolean;
    generatedBy: "agent";
    verificationStatus: "unverified" | "user_verified";
    analyzedChunkCount: number;
    totalChunkCount: number;
  };
}

export interface ProcessSourceContextChunk {
  id: string;
  chunkIndex: number;
  text: string;
  charCount: number;
  locator: {
    sourceId: string;
    chunkId: string;
    chunkIndex: number;
    pageNumber: number | null;
    sectionLabel: string | null;
    precisePdfPage: false;
  };
}

export interface ProcessSourceResult {
  source: {
    id: string;
    kind: string;
    title: string;
    authors: string[];
    year?: number;
    venue?: string;
    doi?: string;
    filePath?: string;
    citationKey?: string;
  };
  parseStatus: string;
  hasExistingPaperCard: boolean;
  existingPaperCard: {
    id: string;
    sourceId: string;
    card: PaperCard;
    evidenceSpanIds: string[];
    createdAt: number;
    updatedAt: number;
  } | null;
  contextChunks: ProcessSourceContextChunk[];
  totalChunkCount: number;
  totalCharCount: number;
  truncated: boolean;
  note?: string;
}

type SupportedDb = {
  prepare: (sql: string) => {
    get: (...args: any[]) => unknown;
    all: (...args: any[]) => unknown[];
  };
};

const MAX_CONTEXT_CHUNKS = 12;
const MAX_CONTEXT_CHARS = 12_000;
const MAX_CHUNK_CHARS = 1_200;

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clipText(text: string, maxLength: number): { text: string; clipped: boolean } {
  if (text.length <= maxLength) {
    return { text, clipped: false };
  }
  return {
    text: `${text.slice(0, maxLength - 3).trim()}...`,
    clipped: true,
  };
}

function formatPaperCard(row: PaperCardRow) {
  return {
    id: row.id,
    sourceId: row.source_id,
    card: JSON.parse(row.card_json) as PaperCard,
    evidenceSpanIds: JSON.parse(row.evidence_span_ids_json || "[]") as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function formatSource(row: SourceRow) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    authors: JSON.parse(row.authors_json || "[]") as string[],
    year: row.year ?? undefined,
    venue: row.venue ?? undefined,
    doi: row.doi ?? undefined,
    filePath: row.file_path ?? undefined,
    citationKey: row.citation_key ?? undefined,
  };
}

function buildContextChunks(chunks: ChunkRow[]): {
  contextChunks: ProcessSourceContextChunk[];
  truncated: boolean;
  totalCharCount: number;
} {
  const validChunks = chunks
    .map((chunk) => ({
      ...chunk,
      normalizedText: normalizeText(chunk.text),
    }))
    .filter((chunk) => chunk.normalizedText.length > 0);

  let remainingChars = MAX_CONTEXT_CHARS;
  let truncated = false;
  const contextChunks: ProcessSourceContextChunk[] = [];

  for (const chunk of validChunks) {
    if (contextChunks.length >= MAX_CONTEXT_CHUNKS || remainingChars <= 0) {
      truncated = true;
      break;
    }

    const perChunk = clipText(chunk.normalizedText, Math.min(MAX_CHUNK_CHARS, remainingChars));
    const finalText = perChunk.text;

    if (finalText.length === 0) {
      truncated = true;
      break;
    }

    contextChunks.push({
      id: chunk.id,
      chunkIndex: chunk.chunk_index,
      text: finalText,
      charCount: finalText.length,
      locator: {
        sourceId: chunk.source_id,
        chunkId: chunk.id,
        chunkIndex: chunk.chunk_index,
        pageNumber: chunk.page_number ?? null,
        sectionLabel: chunk.section_label ?? null,
        precisePdfPage: false,
      },
    });

    remainingChars -= finalText.length;
    if (perChunk.clipped) {
      truncated = true;
      break;
    }
  }

  const totalCharCount = validChunks.reduce((sum, chunk) => sum + chunk.normalizedText.length, 0);
  if (contextChunks.length < validChunks.length) {
    truncated = true;
  }

  return {
    contextChunks,
    truncated,
    totalCharCount,
  };
}

export function processSourceInDb(
  db: SupportedDb,
  input: { sourceId: string },
): ProcessSourceResult {
  const source = db
    .prepare("SELECT * FROM literature_sources WHERE id = ?")
    .get(input.sourceId) as SourceRow | undefined;

  if (!source) {
    throw new Error(`Source not found: ${input.sourceId}`);
  }

  if (source.parse_status !== "parsed") {
    throw new Error(
      `Source ${input.sourceId} is not ready for processing (parse_status=${source.parse_status ?? "missing"}).`,
    );
  }

  const chunks = db
    .prepare(`
      SELECT *
      FROM literature_document_chunks
      WHERE source_id = ?
      ORDER BY chunk_index ASC
    `)
    .all(input.sourceId) as ChunkRow[];

  const validChunkCount = chunks.filter((chunk) => normalizeText(chunk.text).length > 0).length;
  if (validChunkCount === 0) {
    throw new Error(`Source ${input.sourceId} has no parsed text chunks to process.`);
  }

  const existingCard = db
    .prepare("SELECT * FROM literature_paper_cards WHERE source_id = ?")
    .get(input.sourceId) as PaperCardRow | undefined;

  const { contextChunks, truncated, totalCharCount } = buildContextChunks(chunks);

  return {
    source: formatSource(source),
    parseStatus: source.parse_status,
    hasExistingPaperCard: Boolean(existingCard),
    existingPaperCard: existingCard ? formatPaperCard(existingCard) : null,
    contextChunks,
    totalChunkCount: validChunkCount,
    totalCharCount,
    truncated,
    note: truncated
      ? "Only a bounded subset of parsed source text is returned. Do not claim a complete paper analysis without reading additional context."
      : undefined,
  };
}

export const __testables = {
  normalizeText,
  clipText,
  buildContextChunks,
};
