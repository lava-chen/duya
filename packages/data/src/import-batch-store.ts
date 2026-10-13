import { randomUUID } from 'node:crypto';
import type {
  CreateHostImportBatchInput,
  CreateHostImportBatchItemInput,
  HostImportBatch,
  HostImportBatchItem,
} from '@duya/agent-protocol/import-batches';

interface ImportBatchDbRow {
  id: string;
  source: string;
  source_project_path: string | null;
  target_project_path: string | null;
  status: string;
  total_items: number;
  applied_items: number;
  created_at: number;
  rolled_back_at: number | null;
}

interface ImportBatchItemDbRow {
  id: string;
  batch_id: string;
  source_type: string;
  source_path: string;
  source_hash: string | null;
  target_type: string;
  target_path: string;
  title: string;
  summary: string | null;
  risk_level: string;
  requires_auth: number;
  is_enabled: number;
  status: string;
  created_at: number;
}

function batchFromRow(row: ImportBatchDbRow): HostImportBatch {
  return {
    id: row.id,
    source: row.source,
    sourceProjectPath: row.source_project_path,
    targetProjectPath: row.target_project_path,
    status: row.status,
    totalItems: row.total_items,
    appliedItems: row.applied_items,
    createdAt: row.created_at,
    rolledBackAt: row.rolled_back_at,
  };
}

function itemFromRow(row: ImportBatchItemDbRow): HostImportBatchItem {
  return {
    id: row.id,
    batchId: row.batch_id,
    sourceType: row.source_type,
    sourcePath: row.source_path,
    sourceHash: row.source_hash,
    targetType: row.target_type,
    targetPath: row.target_path,
    title: row.title,
    summary: row.summary,
    riskLevel: row.risk_level,
    requiresAuth: row.requires_auth,
    isEnabled: row.is_enabled,
    status: row.status,
    createdAt: row.created_at,
  };
}

/** Host-owned persistence for import history and rollback manifests. */
export class ImportBatchStore {
  constructor(private readonly db: import('better-sqlite3').Database) {}

  create(input: CreateHostImportBatchInput): HostImportBatch {
    const id = randomUUID();
    const createdAt = Date.now();
    this.db.prepare(
      'INSERT INTO import_batches ' +
        '(id, source, source_project_path, target_project_path, status, total_items, applied_items, created_at) ' +
        "VALUES (?, ?, ?, ?, 'pending', ?, 0, ?)",
    ).run(
      id,
      input.source,
      input.sourceProjectPath ?? null,
      input.targetProjectPath ?? null,
      input.totalItems,
      createdAt,
    );
    return {
      id,
      source: input.source,
      sourceProjectPath: input.sourceProjectPath ?? null,
      targetProjectPath: input.targetProjectPath ?? null,
      status: 'pending',
      totalItems: input.totalItems,
      appliedItems: 0,
      createdAt,
      rolledBackAt: null,
    };
  }

  addItem(input: CreateHostImportBatchItemInput): HostImportBatchItem {
    const id = randomUUID();
    const createdAt = Date.now();
    this.db.prepare(
      'INSERT INTO import_items ' +
        '(id, batch_id, source_type, source_path, source_hash, target_type, target_path, title, summary, risk_level, requires_auth, is_enabled, status, created_at) ' +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported', ?)",
    ).run(
      id,
      input.batchId,
      input.sourceType,
      input.sourcePath,
      input.sourceHash,
      input.targetType,
      input.targetPath,
      input.title,
      input.summary,
      input.riskLevel,
      input.requiresAuth,
      input.isEnabled,
      createdAt,
    );
    return { ...input, id, status: 'imported', createdAt };
  }

  updateStatus(batchId: string, status: string, appliedItems: number): void {
    const rolledBackAt = status === 'rolled_back' ? Date.now() : null;
    this.db.prepare(
      'UPDATE import_batches SET status = ?, applied_items = ?, rolled_back_at = ? WHERE id = ?',
    ).run(status, appliedItems, rolledBackAt, batchId);
  }

  rollbackItems(batchId: string): void {
    this.db.prepare(
      "UPDATE import_items SET status = 'rolled_back' WHERE batch_id = ? AND status = 'imported'",
    ).run(batchId);
  }

  getItems(batchId: string): HostImportBatchItem[] {
    const rows = this.db.prepare(
      'SELECT id, batch_id, source_type, source_path, source_hash, target_type, target_path, title, summary, risk_level, requires_auth, is_enabled, status, created_at ' +
        'FROM import_items WHERE batch_id = ?',
    ).all(batchId) as ImportBatchItemDbRow[];
    return rows.map(itemFromRow);
  }

  list(): HostImportBatch[] {
    const rows = this.db.prepare(
      'SELECT id, source, source_project_path, target_project_path, status, total_items, applied_items, created_at, rolled_back_at ' +
        'FROM import_batches ORDER BY created_at DESC',
    ).all() as ImportBatchDbRow[];
    return rows.map(batchFromRow);
  }
}
