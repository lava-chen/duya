export interface HostImportBatch {
  id: string;
  source: string;
  sourceProjectPath: string | null;
  targetProjectPath: string | null;
  status: string;
  totalItems: number;
  appliedItems: number;
  createdAt: number;
  rolledBackAt: number | null;
}

export interface HostImportBatchItem {
  id: string;
  batchId: string;
  sourceType: string;
  sourcePath: string;
  sourceHash: string | null;
  targetType: string;
  targetPath: string;
  title: string;
  summary: string | null;
  riskLevel: string;
  requiresAuth: number;
  isEnabled: number;
  status: string;
  createdAt: number;
}

export interface CreateHostImportBatchInput {
  source: string;
  sourceProjectPath?: string;
  targetProjectPath?: string;
  totalItems: number;
}

export type CreateHostImportBatchItemInput = Omit<HostImportBatchItem, 'id' | 'createdAt' | 'status'>;

/** Local-only API for import history and rollback metadata. */
export interface HostLocalImportBatchApiV1 {
  createBatch(input: CreateHostImportBatchInput): Promise<HostImportBatch>;
  addItem(input: CreateHostImportBatchItemInput): Promise<HostImportBatchItem>;
  updateBatchStatus(batchId: string, status: string, appliedItems: number): Promise<void>;
  rollbackBatchItems(batchId: string): Promise<void>;
  getBatchItems(batchId: string): Promise<HostImportBatchItem[]>;
  listBatches(): Promise<HostImportBatch[]>;
}
