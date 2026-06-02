import { randomUUID } from 'crypto';
import { getDatabase } from '../db/connection';
import { getLogger, LogComponent } from '../logging/logger';
import type { ImportBatch, ImportItemRecord  } from '../types';
import type { ImportItem } from '../types';

const logger = getLogger();

const COMPONENT = 'ImportBatchStore' as LogComponent;

function db(): ReturnType<typeof getDatabase> {
  return getDatabase();
}

export function createBatch(params: {
  source: string;
  sourceProjectPath?: string;
  targetProjectPath?: string;
  totalItems: number;
}): ImportBatch {
  const database = db();
  if (!database) throw new Error('Database not initialized');

  const id = randomUUID();
  const now = Date.now();

  database.prepare(`
    INSERT INTO import_batches (id, source, source_project_path, target_project_path, status, total_items, applied_items, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?, 0, ?)
  `).run(id, params.source, params.sourceProjectPath ?? null, params.targetProjectPath ?? null, params.totalItems, now);

  logger.info('Created import batch', { batchId: id, source: params.source }, COMPONENT);

  return {
    id,
    source: params.source,
    sourceProjectPath: params.sourceProjectPath ?? null,
    targetProjectPath: params.targetProjectPath ?? null,
    status: 'pending',
    totalItems: params.totalItems,
    appliedItems: 0,
    createdAt: now,
    rolledBackAt: null,
  };
}

export function addItem(params: {
  batchId: string;
  item: ImportItem;
  targetType: string;
  targetPath: string;
}): ImportItemRecord {
  const database = db();
  if (!database) throw new Error('Database not initialized');

  const id = randomUUID();
  const now = Date.now();

  database.prepare(`
    INSERT INTO import_items (id, batch_id, source_type, source_path, source_hash, target_type, target_path, title, summary, risk_level, requires_auth, is_enabled, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported', ?)
  `).run(
    id,
    params.batchId,
    params.item.type,
    params.item.sourcePath,
    params.item.sourceHash ?? null,
    params.targetType,
    params.targetPath,
    params.item.title,
    params.item.summary,
    params.item.riskLevel,
    params.item.requiresAuthorization ? 1 : 0,
    params.item.defaultSelected ? 1 : 0,
    now,
  );

  return {
    id,
    batchId: params.batchId,
    sourceType: params.item.type,
    sourcePath: params.item.sourcePath,
    sourceHash: params.item.sourceHash ?? null,
    targetType: params.targetType,
    targetPath: params.targetPath,
    title: params.item.title,
    summary: params.item.summary,
    riskLevel: params.item.riskLevel,
    requiresAuth: params.item.requiresAuthorization ? 1 : 0,
    isEnabled: params.item.defaultSelected ? 1 : 0,
    status: 'imported',
    createdAt: now,
  };
}

export function updateBatchStatus(batchId: string, status: string, appliedItems: number): void {
  const database = db();
  if (!database) throw new Error('Database not initialized');

  const now = Date.now();
  const updates: Record<string, unknown> = {
    status,
    applied_items: appliedItems,
  };

  if (status === 'rolled_back') {
    updates.rolled_back_at = now;
  }

  database.prepare(`
    UPDATE import_batches SET status = ?, applied_items = ?, rolled_back_at = ? WHERE id = ?
  `).run(status, appliedItems, status === 'rolled_back' ? now : null, batchId);

  logger.info('Updated import batch', { batchId, status, appliedItems }, COMPONENT);
}

export function rollbackBatchItems(batchId: string): void {
  const database = db();
  if (!database) throw new Error('Database not initialized');

  database.prepare(`
    UPDATE import_items SET status = 'rolled_back' WHERE batch_id = ? AND status = 'imported'
  `).run(batchId);

  logger.info('Rolled back import items', { batchId }, COMPONENT);
}

export function getBatchItems(batchId: string): ImportItemRecord[] {
  const database = db();
  if (!database) throw new Error('Database not initialized');

  return database.prepare(`
    SELECT id, batch_id, source_type, source_path, source_hash, target_type, target_path, title, summary, risk_level, requires_auth, is_enabled, status, created_at
    FROM import_items WHERE batch_id = ?
  `).all(batchId) as ImportItemRecord[];
}

export function getBatch(batchId: string): ImportBatch | null {
  const database = db();
  if (!database) throw new Error('Database not initialized');

  return database.prepare(`
    SELECT id, source, source_project_path, target_project_path, status, total_items, applied_items, created_at, rolled_back_at
    FROM import_batches WHERE id = ?
  `).get(batchId) as ImportBatch | null;
}

export function listBatches(): ImportBatch[] {
  const database = db();
  if (!database) throw new Error('Database not initialized');

  return database.prepare(`
    SELECT id, source, source_project_path, target_project_path, status, total_items, applied_items, created_at, rolled_back_at
    FROM import_batches ORDER BY created_at DESC
  `).all() as ImportBatch[];
}