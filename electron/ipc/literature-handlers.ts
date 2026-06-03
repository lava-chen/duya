import { ipcMain } from 'electron';
import { basename } from 'path';
import { randomUUID } from 'crypto';
import { getDatabase } from '../db/connection';
import { formatLiteratureCitation, type LiteratureCitationStyle } from '../../packages/agent/src/plugins/literature/shared/citation-format';

type BetterSqlite3Db = import('better-sqlite3').Database;

type ParsedTextChunk = {
  type: 'text';
  index: number;
  text: string;
};

type ParserResult = {
  fileHash: string;
  filename: string;
  charCount: number;
  chunks: Array<ParsedTextChunk | { type: 'image'; index: number; base64: string; mediaType: string }>;
  extractMethod?: 'text' | 'vision' | 'hybrid';
  metadata?: Record<string, unknown>;
  thumbnail?: { base64: string; mediaType: string };
  parsedAt: number;
};

type LiteratureSourceRow = {
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
};

type LiteratureChunkRow = {
  id: string;
  source_id: string;
  chunk_index: number;
  page_number: number | null;
  section_label: string | null;
  text: string;
  char_count: number | null;
  created_at: number;
};

type LiteratureEvidenceRow = {
  id: string;
  source_id: string;
  chunk_id: string | null;
  chunk_index: number | null;
  page: number | null;
  section: string | null;
  text: string;
  quote: string | null;
  bbox_json: string | null;
  created_at: number;
};

type LiteraturePaperCardRow = {
  id: string;
  source_id: string;
  card_json: string;
  evidence_span_ids_json: string;
  created_at: number;
  updated_at: number;
};

type IngestParsedDocumentInput = {
  filePath: string;
  parseResult: ParserResult;
};

function requireDatabase(): BetterSqlite3Db {
  const db = getDatabase();
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
}

function findExistingSource(db: BetterSqlite3Db, fileHash: string, filePath: string): LiteratureSourceRow | undefined {
  if (fileHash) {
    const byHash = db.prepare('SELECT * FROM literature_sources WHERE file_hash = ? ORDER BY updated_at DESC LIMIT 1').get(fileHash) as LiteratureSourceRow | undefined;
    if (byHash) {
      return byHash;
    }
  }

  return db.prepare('SELECT * FROM literature_sources WHERE file_path = ? ORDER BY updated_at DESC LIMIT 1').get(filePath) as LiteratureSourceRow | undefined;
}

function ingestParsedDocument(db: BetterSqlite3Db, input: IngestParsedDocumentInput) {
  const now = Date.now();
  const existing = findExistingSource(db, input.parseResult.fileHash, input.filePath);
  const title = existing?.title
    ?? (input.parseResult.metadata && typeof input.parseResult.metadata.title === 'string' && input.parseResult.metadata.title.trim()
      ? input.parseResult.metadata.title.trim()
      : basename(input.filePath));
  const sourceId = existing?.id ?? randomUUID();
  const metadata = {
    filename: input.parseResult.filename,
    charCount: input.parseResult.charCount,
    extractMethod: input.parseResult.extractMethod ?? null,
    parsedAt: input.parseResult.parsedAt,
    parserMetadata: input.parseResult.metadata ?? {},
  };
  const textChunks = input.parseResult.chunks.filter(
    (chunk): chunk is ParsedTextChunk => chunk.type === 'text' && typeof chunk.text === 'string' && chunk.text.trim().length > 0,
  );

  const upsertSource = db.prepare(`
    INSERT INTO literature_sources (
      id, kind, title, authors_json, year, venue, doi, arxiv_id,
      url, file_path, file_hash, citation_key, bibtex, project_ids_json, tags_json,
      parse_status, parse_error, parse_metadata_json, created_at, updated_at
    ) VALUES (
      @id, @kind, @title, @authors_json, @year, @venue, @doi, @arxiv_id,
      @url, @file_path, @file_hash, @citation_key, @bibtex, @project_ids_json, @tags_json,
      @parse_status, @parse_error, @parse_metadata_json, @created_at, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      title = @title,
      file_path = @file_path,
      file_hash = @file_hash,
      parse_status = @parse_status,
      parse_error = @parse_error,
      parse_metadata_json = @parse_metadata_json,
      updated_at = @updated_at
  `);
  const deleteChunks = db.prepare('DELETE FROM literature_document_chunks WHERE source_id = ?');
  const insertChunk = db.prepare(`
    INSERT INTO literature_document_chunks (
      id, source_id, chunk_index, page_number, section_label, text, char_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getChunkCount = db.prepare('SELECT COUNT(*) as count FROM literature_document_chunks WHERE source_id = ?');
  const getSource = db.prepare('SELECT * FROM literature_sources WHERE id = ?');

  const txn = db.transaction(() => {
    upsertSource.run({
      id: sourceId,
      kind: existing?.kind ?? 'paper',
      title,
      authors_json: existing?.authors_json ?? '[]',
      year: existing?.year ?? null,
      venue: existing?.venue ?? null,
      doi: existing?.doi ?? null,
      arxiv_id: existing?.arxiv_id ?? null,
      url: existing?.url ?? null,
      file_path: input.filePath,
      file_hash: input.parseResult.fileHash,
      citation_key: existing?.citation_key ?? null,
      bibtex: existing?.bibtex ?? null,
      project_ids_json: existing?.project_ids_json ?? '[]',
      tags_json: existing?.tags_json ?? '[]',
      parse_status: 'parsed',
      parse_error: null,
      parse_metadata_json: JSON.stringify(metadata),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    });

    deleteChunks.run(sourceId);
    for (const chunk of textChunks) {
      insertChunk.run(
        randomUUID(),
        sourceId,
        chunk.index,
        null,
        null,
        chunk.text,
        chunk.text.length,
        now,
      );
    }

    const source = getSource.get(sourceId) as LiteratureSourceRow;
    const chunkCount = Number((getChunkCount.get(sourceId) as { count: number }).count);
    return {
      action: existing ? 'updated' : 'created',
      source: toRendererSource(source, chunkCount),
    };
  });

  return txn();
}

function toRendererSource(row: LiteratureSourceRow, chunkCount: number) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    authors: JSON.parse(row.authors_json || '[]') as string[],
    year: row.year ?? undefined,
    venue: row.venue ?? undefined,
    doi: row.doi ?? undefined,
    arxivId: row.arxiv_id ?? undefined,
    url: row.url ?? undefined,
    filePath: row.file_path ?? undefined,
    fileHash: row.file_hash ?? undefined,
    citationKey: row.citation_key ?? undefined,
    bibtex: row.bibtex ?? undefined,
    projectIds: JSON.parse(row.project_ids_json || '[]') as string[],
    tags: JSON.parse(row.tags_json || '[]') as string[],
    parseStatus: row.parse_status ?? 'pending',
    parseError: row.parse_error ?? undefined,
    parseMetadata: row.parse_metadata_json ? JSON.parse(row.parse_metadata_json) as Record<string, unknown> : {},
    chunkCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRendererChunk(row: LiteratureChunkRow) {
  return {
    id: row.id,
    sourceId: row.source_id,
    chunkIndex: row.chunk_index,
    pageNumber: row.page_number ?? null,
    sectionLabel: row.section_label ?? null,
    text: row.text,
    charCount: row.char_count ?? row.text.length,
    createdAt: row.created_at,
  };
}

function toRendererPaperCard(row: LiteraturePaperCardRow) {
  return {
    id: row.id,
    sourceId: row.source_id,
    card: JSON.parse(row.card_json) as Record<string, unknown>,
    evidenceSpanIds: JSON.parse(row.evidence_span_ids_json || '[]') as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRendererEvidence(row: LiteratureEvidenceRow) {
  return {
    id: row.id,
    sourceId: row.source_id,
    chunkId: row.chunk_id ?? undefined,
    chunkIndex: row.chunk_index ?? undefined,
    pageNumber: row.page ?? null,
    sectionLabel: row.section ?? null,
    text: row.text,
    quote: row.quote ?? undefined,
    createdAt: row.created_at,
  };
}

function saveEvidence(db: BetterSqlite3Db, input: {
  sourceId: string;
  chunkId?: string;
  chunkIndex?: number;
  pageNumber?: number | null;
  sectionLabel?: string | null;
  text: string;
  quote: string;
}) {
  const sourceExists = db.prepare('SELECT id FROM literature_sources WHERE id = ?').get(input.sourceId) as { id: string } | undefined;
  if (!sourceExists) {
    throw new Error(`No source found with ID: ${input.sourceId}`);
  }

  const existing = input.chunkId
    ? db.prepare(`
        SELECT *
        FROM literature_evidence_spans
        WHERE source_id = ? AND chunk_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(input.sourceId, input.chunkId) as LiteratureEvidenceRow | undefined
    : undefined;

  if (existing) {
    return {
      action: 'existing' as const,
      evidence: toRendererEvidence(existing),
    };
  }

  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO literature_evidence_spans (
      id, source_id, chunk_id, chunk_index, page, section, text, quote, bbox_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.sourceId,
    input.chunkId ?? null,
    input.chunkIndex ?? null,
    input.pageNumber ?? null,
    input.sectionLabel ?? null,
    input.text,
    input.quote,
    null,
    now,
  );

  const row = db.prepare('SELECT * FROM literature_evidence_spans WHERE id = ?').get(id) as LiteratureEvidenceRow;
  return {
    action: 'created' as const,
    evidence: toRendererEvidence(row),
  };
}

function getCitation(db: BetterSqlite3Db, sourceId: string, style: LiteratureCitationStyle): string {
  const row = db.prepare('SELECT * FROM literature_sources WHERE id = ?').get(sourceId) as LiteratureSourceRow | undefined;
  if (!row) {
    throw new Error(`No source found with ID: ${sourceId}`);
  }

  return formatLiteratureCitation({
    title: row.title,
    authors: JSON.parse(row.authors_json || '[]') as string[],
    year: row.year ?? undefined,
    venue: row.venue ?? undefined,
    doi: row.doi ?? undefined,
    bibtex: row.bibtex ?? undefined,
    citationKey: row.citation_key ?? undefined,
  }, style);
}

export function registerLiteratureHandlers(): void {
  ipcMain.handle('literature:ingestParsedDocument', async (_event, input: IngestParsedDocumentInput) => {
    const db = requireDatabase();
    return ingestParsedDocument(db, input);
  });

  ipcMain.handle('literature:listSources', async () => {
    const db = requireDatabase();
    const rows = db.prepare(`
      SELECT
        s.*,
        COUNT(c.id) AS chunk_count
      FROM literature_sources s
      LEFT JOIN literature_document_chunks c ON c.source_id = s.id
      GROUP BY s.id
      ORDER BY s.updated_at DESC
    `).all() as Array<LiteratureSourceRow & { chunk_count: number }>;

    return rows.map((row) => toRendererSource(row, Number(row.chunk_count)));
  });

  ipcMain.handle('literature:getSource', async (_event, sourceId: string) => {
    const db = requireDatabase();
    const row = db.prepare(`
      SELECT
        s.*,
        COUNT(c.id) AS chunk_count
      FROM literature_sources s
      LEFT JOIN literature_document_chunks c ON c.source_id = s.id
      WHERE s.id = ?
      GROUP BY s.id
    `).get(sourceId) as (LiteratureSourceRow & { chunk_count: number }) | undefined;

    if (!row) {
      return null;
    }

    return toRendererSource(row, Number(row.chunk_count));
  });

  ipcMain.handle('literature:listChunks', async (_event, sourceId: string, limit = 20) => {
    const db = requireDatabase();
    const rows = db.prepare(`
      SELECT *
      FROM literature_document_chunks
      WHERE source_id = ?
      ORDER BY chunk_index ASC
      LIMIT ?
    `).all(sourceId, limit) as LiteratureChunkRow[];

    return rows.map(toRendererChunk);
  });

  ipcMain.handle('literature:getPaperCard', async (_event, sourceId: string) => {
    const db = requireDatabase();
    const row = db.prepare(`
      SELECT *
      FROM literature_paper_cards
      WHERE source_id = ?
    `).get(sourceId) as LiteraturePaperCardRow | undefined;

    if (!row) {
      return null;
    }

    return toRendererPaperCard(row);
  });

  ipcMain.handle('literature:listEvidence', async (_event, sourceId: string) => {
    const db = requireDatabase();
    const rows = db.prepare(`
      SELECT *
      FROM literature_evidence_spans
      WHERE source_id = ?
      ORDER BY created_at DESC
    `).all(sourceId) as LiteratureEvidenceRow[];
    return rows.map(toRendererEvidence);
  });

  ipcMain.handle('literature:saveEvidence', async (_event, input: {
    sourceId: string;
    chunkId?: string;
    chunkIndex?: number;
    pageNumber?: number | null;
    sectionLabel?: string | null;
    text: string;
    quote: string;
  }) => {
    const db = requireDatabase();
    return saveEvidence(db, input);
  });

  ipcMain.handle('literature:getCitation', async (_event, sourceId: string, style: LiteratureCitationStyle) => {
    const db = requireDatabase();
    return getCitation(db, sourceId, style);
  });
}

export const __testables = {
  ingestParsedDocument,
  saveEvidence,
  getCitation,
};
