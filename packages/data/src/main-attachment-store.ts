import type { HostLocalParsedDocument } from '@duya/agent-protocol/session-api';
import type { SqliteDatabase } from './core-database.js';

interface LegacyAttachmentRow {
  id: string;
  message_id: string | null;
  session_id: string;
  data: string;
  original_url: string | null;
  created_at: number;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parsedDocument(row: LegacyAttachmentRow): HostLocalParsedDocument {
  const data = record(row.data);
  const imageChunks = data.imageChunks;
  return {
    id: row.id,
    message_id: row.message_id ?? '',
    session_id: row.session_id,
    filename: typeof data.filename === 'string' ? data.filename : '',
    filePath: typeof data.filePath === 'string' ? data.filePath : row.original_url ?? '',
    charCount: typeof data.charCount === 'number' && Number.isFinite(data.charCount) ? data.charCount : 0,
    extractMethod: typeof data.extractMethod === 'string' ? data.extractMethod : null,
    text: typeof data.text === 'string' ? data.text : '',
    imageChunks: imageChunks === undefined || imageChunks === null ? null : JSON.stringify(imageChunks),
    created_at: row.created_at,
  };
}

/** Read-only compatibility projection for parsed documents in the legacy main DB. */
export class MainAttachmentStore {
  constructor(private readonly db: SqliteDatabase) {}

  getParsedDocumentsForSession(sessionId: string): HostLocalParsedDocument[] {
    const rows = this.db.prepare(`
      SELECT id, message_id, session_id, data, original_url, created_at
      FROM message_attachments
      WHERE session_id = ? AND attachment_type = 'parsed_document'
      ORDER BY created_at ASC
    `).all(sessionId) as LegacyAttachmentRow[];
    return rows.map(parsedDocument);
  }

  getParsedDocumentsForMessage(messageId: string): HostLocalParsedDocument[] {
    const rows = this.db.prepare(`
      SELECT id, message_id, session_id, data, original_url, created_at
      FROM message_attachments
      WHERE message_id = ? AND attachment_type = 'parsed_document'
      ORDER BY created_at ASC
    `).all(messageId) as LegacyAttachmentRow[];
    return rows.map(parsedDocument);
  }
}
