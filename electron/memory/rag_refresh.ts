/**
 * electron/memory/rag_refresh.ts — shared RAG index executor + on-demand
 * rebuild (plan 428/430 follow-up).
 *
 * Extracts the `[memory.rag]` → index refresh wiring that `main.ts` used
 * inline into one place so the curation pipeline, the CLI
 * (`POST /v1/memory/rebuild`) and the Settings IPC (`memory:rag-rebuild`)
 * all rebuild the same index the same way:
 *
 *   1. read `[memory.rag]` from the config store (off by default);
 *   2. resolve scan roots (memory root always first) and the index path;
 *   3. resolve an embedding client through the provider framework
 *      (null → keyword-only, e.g. Anthropic);
 *   4. run `refreshMemoryRagIndex` and report the result.
 */

import * as os from 'os';
import * as path from 'path';
import { getConfigStore } from '../config/store-instance';
import { getProviderStore } from '../services/providers/provider-store-electron';
import {
  resolveScanRoots,
  refreshMemoryRagIndex,
  defaultRagIndexPath,
  type RagRefreshResult,
} from './rag_index';
import { createEmbeddingClient } from './rag_embedding_client';
import { writeSystemLog } from '../../packages/agent/src/memory-state/system_log';
import { getLogger, LogComponent } from '../logging/logger';

export type { RagRefreshResult } from './rag_index';

const logger = getLogger();

/** Minimal `[memory.rag]` view used by the executor. */
interface RagConfigView {
  enabled: boolean;
  index_path: string;
  scan_paths: string[];
  embedding_enabled: boolean;
  embedding_provider: string;
  embedding_model: string;
}

function readRagConfig(): RagConfigView {
  const cfg = (getConfigStore().getByPath('memory.rag') ?? {}) as Partial<RagConfigView>;
  return {
    enabled: cfg.enabled === true,
    index_path: typeof cfg.index_path === 'string' ? cfg.index_path : '',
    scan_paths: Array.isArray(cfg.scan_paths) ? cfg.scan_paths.map(String) : [],
    embedding_enabled: cfg.embedding_enabled !== false,
    embedding_provider: typeof cfg.embedding_provider === 'string' ? cfg.embedding_provider : '',
    embedding_model: typeof cfg.embedding_model === 'string' ? cfg.embedding_model : '',
  };
}

export interface RagIndexExecutor {
  /** Rebuild the index over the given memory root. Never throws. */
  refresh(memoryRoot: string): Promise<RagRefreshResult>;
}

/**
 * Build the RAG index executor from the live config store. Returns
 * `undefined` when `[memory.rag].enabled` is not set (capability off) or
 * the executor cannot be constructed — callers then skip the refresh
 * (best-effort, never throws).
 */
export function createRagIndexExecutor(): RagIndexExecutor | undefined {
  try {
    const cfg = readRagConfig();
    if (!cfg.enabled) return undefined;

    const homeDir = os.homedir();
    const dbPath =
      cfg.index_path && cfg.index_path.trim() !== ''
        ? cfg.index_path.trim()
        : defaultRagIndexPath(homeDir);

    const providerStore = getProviderStore();
    const embeddingClient = createEmbeddingClient(providerStore, {
      providerId: cfg.embedding_provider || undefined,
      modelId: cfg.embedding_model || undefined,
    });
    const memProvider = providerStore.getMemoryLlmProvider();
    const embeddingLabel = [
      cfg.embedding_provider || memProvider?.id || '',
      cfg.embedding_model || providerStore.getMemoryModel() || '',
    ]
      .filter(Boolean)
      .join('/');

    return {
      refresh: async (memoryRoot: string): Promise<RagRefreshResult> => {
        const result = await refreshMemoryRagIndex(
          resolveScanRoots(memoryRoot, cfg.scan_paths, homeDir),
          {
            dbPath,
            embeddingEnabled: cfg.embedding_enabled,
            embeddingClient,
            embeddingLabel,
          },
        );
        logger.info(
          'RAG index refreshed',
          {
            documents: result.documents,
            embedded: result.embedded,
            scanRoots: result.scanRoots.length,
          },
          LogComponent.DB,
        );
        return result;
      },
    };
  } catch (ragErr) {
    logger.warn(
      'RAG index refresh setup failed; disabled',
      { error: ragErr instanceof Error ? ragErr.message : String(ragErr) },
      LogComponent.DB,
    );
    return undefined;
  }
}

export interface RagRebuildOk {
  ok: true;
  documents: number;
  embedded: number;
  scanRoots: string[];
  durationMs: number;
}

export interface RagRebuildErr {
  ok: false;
  error: string;
}

export type RagRebuildResult = RagRebuildOk | RagRebuildErr;

/**
 * Rebuild the retrievable memory index on demand (CLI `duya memory
 * rebuild` / Settings button). Returns the refresh result or a
 * user-facing error; on success one `rag_index_rebuilt_manual` event is
 * appended to the memory system log.
 */
export async function rebuildRagIndexNow(): Promise<RagRebuildResult> {
  const executor = createRagIndexExecutor();
  if (!executor) {
    return {
      ok: false,
      error:
        'RAG is not enabled — enable [memory.rag] first (duya memory setup, or Settings → Memory → Retrieval)',
    };
  }
  try {
    const result = await executor.refresh(path.join(os.homedir(), '.duya', 'memory'));
    writeSystemLog({
      phase: 'system',
      eventType: 'rag_index_rebuilt_manual',
      level: 'info',
      message: 'RAG index rebuilt on demand',
      detail: {
        documents: result.documents,
        embedded: result.embedded,
        scanRoots: result.scanRoots,
        durationMs: result.durationMs,
      },
    });
    return {
      ok: true,
      documents: result.documents,
      embedded: result.embedded,
      scanRoots: result.scanRoots,
      durationMs: result.durationMs,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
