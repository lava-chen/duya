import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => 'E:/Projects/duya/.tmp-test',
  },
}));

import { __testables } from './literature-handlers';

type FakeSourceRow = {
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

type FakeChunkRow = {
  id: string;
  source_id: string;
  chunk_index: number;
  page_number: number | null;
  section_label: string | null;
  text: string;
  char_count: number | null;
  created_at: number;
};

type FakeEvidenceRow = {
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

class FakeDb {
  sources = new Map<string, FakeSourceRow>();
  chunks: FakeChunkRow[] = [];
  evidence: FakeEvidenceRow[] = [];

  prepare(sql: string) {
    if (sql.includes('SELECT * FROM literature_sources WHERE file_hash = ?')) {
      return {
        get: (fileHash: string) => {
          const rows = [...this.sources.values()].filter((row) => row.file_hash === fileHash);
          rows.sort((a, b) => b.updated_at - a.updated_at);
          return rows[0];
        },
      };
    }

    if (sql.includes('SELECT * FROM literature_sources WHERE file_path = ?')) {
      return {
        get: (filePath: string) => {
          const rows = [...this.sources.values()].filter((row) => row.file_path === filePath);
          rows.sort((a, b) => b.updated_at - a.updated_at);
          return rows[0];
        },
      };
    }

    if (sql.includes('INSERT INTO literature_sources')) {
      return {
        run: (row: FakeSourceRow) => {
          this.sources.set(row.id, { ...row });
        },
      };
    }

    if (sql.includes('DELETE FROM literature_document_chunks WHERE source_id = ?')) {
      return {
        run: (sourceId: string) => {
          this.chunks = this.chunks.filter((chunk) => chunk.source_id !== sourceId);
        },
      };
    }

    if (sql.includes('INSERT INTO literature_document_chunks')) {
      return {
        run: (
          id: string,
          sourceId: string,
          chunkIndex: number,
          pageNumber: number | null,
          sectionLabel: string | null,
          text: string,
          charCount: number | null,
          createdAt: number,
        ) => {
          this.chunks.push({
            id,
            source_id: sourceId,
            chunk_index: chunkIndex,
            page_number: pageNumber,
            section_label: sectionLabel,
            text,
            char_count: charCount,
            created_at: createdAt,
          });
        },
      };
    }

    if (sql.includes('SELECT COUNT(*) as count FROM literature_document_chunks WHERE source_id = ?')) {
      return {
        get: (sourceId: string) => ({
          count: this.chunks.filter((chunk) => chunk.source_id === sourceId).length,
        }),
      };
    }

    if (sql.includes('SELECT * FROM literature_sources WHERE id = ?')) {
      return {
        get: (sourceId: string) => this.sources.get(sourceId),
      };
    }

    if (sql.includes('SELECT id FROM literature_sources WHERE id = ?')) {
      return {
        get: (sourceId: string) => {
          const row = this.sources.get(sourceId);
          return row ? { id: row.id } : undefined;
        },
      };
    }

    if (sql.includes('WHERE source_id = ? AND chunk_id = ?')) {
      return {
        get: (sourceId: string, chunkId: string) =>
          this.evidence
            .filter((row) => row.source_id === sourceId && row.chunk_id === chunkId)
            .sort((a, b) => b.created_at - a.created_at)[0],
      };
    }

    if (sql.includes('INSERT INTO literature_evidence_spans')) {
      return {
        run: (
          id: string,
          sourceId: string,
          chunkId: string | null,
          chunkIndex: number | null,
          page: number | null,
          section: string | null,
          text: string,
          quote: string | null,
          bboxJson: string | null,
          createdAt: number,
        ) => {
          this.evidence.push({
            id,
            source_id: sourceId,
            chunk_id: chunkId,
            chunk_index: chunkIndex,
            page,
            section,
            text,
            quote,
            bbox_json: bboxJson,
            created_at: createdAt,
          });
        },
      };
    }

    if (sql.includes('SELECT * FROM literature_evidence_spans WHERE id = ?')) {
      return {
        get: (id: string) => this.evidence.find((row) => row.id === id),
      };
    }

    throw new Error(`Unsupported SQL in fake DB: ${sql}`);
  }

  transaction<T>(fn: () => T) {
    return () => fn();
  }
}

function createTestDb() {
  return new FakeDb();
}

describe('literature ingestion', () => {
  it('creates a new source and stores parsed text chunks', () => {
    const db = createTestDb();

    const result = __testables.ingestParsedDocument(db as never, {
      filePath: 'C:\\papers\\alpha.pdf',
      parseResult: {
        fileHash: 'hash-alpha',
        sessionId: 'session-1',
        filename: 'alpha.pdf',
        charCount: 42,
        chunks: [
          { type: 'text', index: 0, text: 'First chunk' },
          { type: 'image', index: 1, base64: 'ignored', mediaType: 'image/png' },
          { type: 'text', index: 2, text: 'Second chunk' },
        ],
        extractMethod: 'text',
        parsedAt: 123,
      },
    });

    expect(result.action).toBe('created');
    expect(result.source.filePath).toBe('C:\\papers\\alpha.pdf');
    expect(result.source.fileHash).toBe('hash-alpha');
    expect(result.source.chunkCount).toBe(2);
    expect(result.source.parseStatus).toBe('parsed');
    expect(db.chunks.map((chunk) => ({ chunk_index: chunk.chunk_index, text: chunk.text }))).toEqual([
      { chunk_index: 0, text: 'First chunk' },
      { chunk_index: 2, text: 'Second chunk' },
    ]);
  });

  it('reuses an existing source when file hash matches and replaces chunks', () => {
    const db = createTestDb();

    const initial = __testables.ingestParsedDocument(db as never, {
      filePath: 'C:\\papers\\alpha.pdf',
      parseResult: {
        fileHash: 'same-hash',
        sessionId: 'session-1',
        filename: 'alpha.pdf',
        charCount: 10,
        chunks: [{ type: 'text', index: 0, text: 'Old chunk' }],
        extractMethod: 'text',
        parsedAt: 100,
      },
    });

    const updated = __testables.ingestParsedDocument(db as never, {
      filePath: 'D:\\imports\\renamed-alpha.pdf',
      parseResult: {
        fileHash: 'same-hash',
        sessionId: 'session-2',
        filename: 'renamed-alpha.pdf',
        charCount: 22,
        chunks: [{ type: 'text', index: 0, text: 'New chunk' }],
        extractMethod: 'hybrid',
        parsedAt: 200,
      },
    });

    expect(updated.action).toBe('updated');
    expect(updated.source.id).toBe(initial.source.id);
    expect(updated.source.filePath).toBe('D:\\imports\\renamed-alpha.pdf');
    expect(updated.source.chunkCount).toBe(1);
    expect(db.sources.size).toBe(1);
    expect(db.chunks.map((chunk) => chunk.text)).toEqual(['New chunk']);
  });
});

describe('literature evidence save and citation reuse', () => {
  it('creates formal evidence only after an explicit save action and deduplicates by chunk id', () => {
    const db = createTestDb();
    db.sources.set('source-1', {
      id: 'source-1',
      kind: 'paper',
      title: 'Sample Paper',
      authors_json: JSON.stringify(['Ada Lovelace']),
      year: 2026,
      venue: 'ICML',
      doi: '10.1000/example',
      arxiv_id: null,
      url: null,
      file_path: 'C:\\papers\\sample.pdf',
      file_hash: 'hash',
      citation_key: 'sample2026',
      bibtex: null,
      project_ids_json: '[]',
      tags_json: '[]',
      parse_status: 'parsed',
      parse_error: null,
      parse_metadata_json: '{}',
      created_at: 1,
      updated_at: 2,
    });

    const firstSave = __testables.saveEvidence(db as never, {
      sourceId: 'source-1',
      chunkId: 'chunk-1',
      chunkIndex: 3,
      text: 'Original parsed chunk text',
      quote: 'Original parsed chunk text',
      pageNumber: null,
      sectionLabel: null,
    });
    const secondSave = __testables.saveEvidence(db as never, {
      sourceId: 'source-1',
      chunkId: 'chunk-1',
      chunkIndex: 3,
      text: 'Original parsed chunk text',
      quote: 'Original parsed chunk text',
      pageNumber: null,
      sectionLabel: null,
    });

    expect(firstSave.action).toBe('created');
    expect(firstSave.evidence.chunkId).toBe('chunk-1');
    expect(firstSave.evidence.chunkIndex).toBe(3);
    expect(secondSave.action).toBe('existing');
    expect(db.evidence).toHaveLength(1);
  });

  it('formats citation text with the shared literature formatter', () => {
    const db = createTestDb();
    db.sources.set('source-1', {
      id: 'source-1',
      kind: 'paper',
      title: 'Sample Paper',
      authors_json: JSON.stringify(['Ada Lovelace', 'Grace Hopper']),
      year: 2026,
      venue: 'ICML',
      doi: '10.1000/example',
      arxiv_id: null,
      url: null,
      file_path: 'C:\\papers\\sample.pdf',
      file_hash: 'hash',
      citation_key: 'sample2026',
      bibtex: null,
      project_ids_json: '[]',
      tags_json: '[]',
      parse_status: 'parsed',
      parse_error: null,
      parse_metadata_json: '{}',
      created_at: 1,
      updated_at: 2,
    });

    const apa = __testables.getCitation(db as never, 'source-1', 'apa');
    const bibtex = __testables.getCitation(db as never, 'source-1', 'bibtex');

    expect(apa).toContain('Lovelace');
    expect(apa).toContain('Sample Paper');
    expect(bibtex).toContain('@article{sample2026');
  });
});
