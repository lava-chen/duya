import type {
  ImportSource,
  ScanResult,
  ApplyImportParams,
  ImportManifest,
  ImportBatch,
} from '@/types/import';

export interface DetectResult {
  claude: boolean;
  codex: boolean;
}

function getImportApi() {
  if (!window.electronAPI?.import) {
    throw new Error('Import API not available');
  }
  return window.electronAPI.import;
}

export async function detectImportIPC(): Promise<DetectResult> {
  return getImportApi().detect();
}

export async function scanImportIPC(
  source: ImportSource,
  projectPath?: string,
): Promise<ScanResult> {
  return getImportApi().scan({ source, projectPath }) as Promise<ScanResult>;
}

export async function applyImportIPC(
  params: ApplyImportParams,
): Promise<ImportManifest> {
  return getImportApi().apply(params) as Promise<ImportManifest>;
}

export async function rollbackImportIPC(
  batchId: string,
): Promise<void> {
  return getImportApi().rollback({ batchId });
}

export async function historyImportIPC(): Promise<ImportBatch[]> {
  return getImportApi().history() as Promise<ImportBatch[]>;
}