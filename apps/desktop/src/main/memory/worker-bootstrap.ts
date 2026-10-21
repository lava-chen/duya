/**
 * memory/worker-bootstrap.ts — memory worker start/stop orchestration.
 *
 * Extracted from main.ts (2026-09-23) so the worker can be started both
 * at boot (when `memory.memory_enabled` is true in config.toml) and at
 * runtime from the settings toggle IPC (`settings:set-memory-enabled`).
 *
 * The user-facing toggle used to write only the SQLite settings table
 * (`memoryEnabled` key) while every consumer (main.ts worker gate,
 * agent-server lifecycle env, process-pool env) reads
 * `memory.memory_enabled` from config.toml — the toggle never reached the
 * worker. Two fixes landed together:
 *
 *   1. `syncMemoryToggleFromHostSettings()` — one-time boot alignment that
 *      reads the legacy SQLite UI value through the Host Settings API and
 *      treats it as the user's intent when config.toml disagrees.
 *   2. `startMemoryWorkerFromConfig()` — reusable hot-start used by boot
 *      and the toggle IPC (the toggle pauses/resumes the running handle
 *      without tearing it down; hot-start only fills the "booted while
 *      disabled" gap).
 */

import * as fs from 'fs';
import * as path from 'path';
import { getLogger, LogComponent } from '../logging/logger';
import { getDatabasePath } from '../config/boot-config';
import {
  getDesktopHostLocalSessionApi,
  getDesktopHostLocalProjectApi,
  getDesktopHostLocalSettingsApi,
  getDesktopHostSessionApi,
} from '../cli/desktop-host-api';
import { getProviderStore } from '../services/providers/provider-store-electron';
import { readHostMessageRows } from '../services/host-message-reader';
import type { MemoryCatalogSource } from '../memory-state/catalogSync';
import { isLowPowerEnabled } from '../services/low-power';
import { resolveMemoryModel } from '../services/providers/memory-model-resolution';
import { toLegacyApiProvider } from '../../renderer/lib/providers/legacy';
import { createRagIndexExecutor } from './rag_refresh';
import { getConfigStore } from '../config/store-instance';

const logger = getLogger();

export type MemoryWorkerStartOutcome =
  | 'already-running'
  | 'started'
  | 'no-llm'
  | 'failed';

/**
 * Ensure the curation config root exists with default files. Without
 * `memory-config/`, the memory_write tool and the Stage 1 extractor
 * have no policy to read. (Moved verbatim from main.ts.)
 */
export async function ensureMemoryConfigDir(configRoot: string): Promise<void> {
  fs.mkdirSync(configRoot, { recursive: true });

  const policyPath = path.join(configRoot, 'stage1_policy.md');
  if (!fs.existsSync(policyPath)) {
    // Empty policy — the full Stage 1 system prompt is just the hard contract.
    fs.writeFileSync(policyPath, '');
  }

  const layoutPath = path.join(configRoot, 'memory_layout.json');
  if (!fs.existsSync(layoutPath)) {
    const { DEFAULT_LAYOUT } = await import('@duya/memory/memory_layout');
    const entities: Record<string, unknown> = {};
    for (const [claimType, cfg] of DEFAULT_LAYOUT.entities) {
      entities[claimType] = cfg;
    }
    fs.writeFileSync(
      layoutPath,
      JSON.stringify({ schema_version: DEFAULT_LAYOUT.schema_version, entities }, null, 2),
    );
  }
}

/**
 * Start the memory worker (shadow mode) from the current provider/config
 * state. Idempotent: returns 'already-running' when the singleton handle
 * exists (even if paused — callers decide pause/resume separately).
 *
 * Outcome semantics:
 *   - 'started'         worker is running
 *   - 'already-running' singleton exists; nothing to do
 *   - 'no-llm'          no usable memory provider — worker not started
 *   - 'failed'          bootstrap error (logged)
 */
export async function startMemoryWorkerFromConfig(): Promise<MemoryWorkerStartOutcome> {
  const { getMemoryWorkerHandle } = await import('./memory-worker');
  if (getMemoryWorkerHandle()) {
    return 'already-running';
  }
  try {
    const { bootstrap } = await import('../memory-state');
    const { startMemoryWorker, applyLowPowerOverrides } = await import('./memory-worker');
    const { createAIClientWithRetry } = await import('@duya/ai');
    const { toLLMProvider } = await import('../config/provider-types');
    const { toRuntimeConfigFromLegacy } = await import('@duya/ai');

    const memoryDb = bootstrap({ bootJsonDatabaseDir: path.dirname(getDatabasePath()) });

    // The authenticated Host local API supplies complete session snapshots,
    // timeline index metadata, and project path resolution.
    const catalogSource: MemoryCatalogSource = {
      async listSessions() {
        const api = getDesktopHostLocalSessionApi();
        const sessions = [];
        let cursor: string | undefined;
        do {
          const page = await api.listLocalSessions({
            includeAllSessions: true,
            includeArchived: true,
            includeDeleted: true,
            limit: 200,
            ...(cursor === undefined ? {} : { cursor }),
          });
          sessions.push(...page.sessions);
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        return sessions;
      },
      async readMessageIndex(sessionId) {
        const api = getDesktopHostSessionApi();
        const rows = [];
        let cursor: string | undefined;
        do {
          const page = await api.readProjectedTimeline(sessionId, {
            limit: 200,
            ...(cursor === undefined ? {} : { cursor }),
          });
          rows.push(...page.entries.map((entry) => ({
            id: entry.id,
            seq: entry.sequence,
            created_at: entry.createdAt,
          })));
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        return rows;
      },
      async resolveProject(input) {
        const resolved = await getDesktopHostLocalProjectApi().resolveProjectPath({
          workingDirectory: input.workingDirectory,
          agentProfileId: input.agent_profile_id ?? null,
          cwd: input.cwd,
          workspaceOverridesPath: input.workspaceOverridesPath,
        });
        return {
          project_id: resolved.projectId,
          canonical_root: resolved.canonicalRoot,
          resolution_source: resolved.resolutionSource,
          alias_kind: resolved.aliasKind,
          absolute_normalized_path: resolved.absoluteNormalizedPath,
        };
      },
    };

    // Construct LLM client from the memory worker provider. When
    // memoryProviderId is unset, getMemoryProvider() falls back to
    // the default provider. Falls back gracefully if no provider is
    // configured — the worker will still run reconcile + outbox,
    // just no extraction.
    let llmClient = null;
    let curationProviderConfig = null;
    try {
      const providerStore = getProviderStore();
      const activeLlm = providerStore.getMemoryLlmProvider();
      const provider = activeLlm ? toLegacyApiProvider(activeLlm) : undefined;
      if (provider) {
        const memoryModel = providerStore.getMemoryModel();
        const llmProvider = toLLMProvider(provider.providerType, provider.baseUrl);
        const model = resolveMemoryModel(
          provider,
          memoryModel,
          llmProvider === 'anthropic' || llmProvider === 'openai' || llmProvider === 'ollama'
            ? llmProvider
            : 'ollama',
        );
        logger.info('Memory worker: model resolved', { model, providerId: provider.id, memoryModelId: memoryModel }, LogComponent.DB);
        // Build a ProviderRuntimeConfig from the legacy ApiProvider so
        // domestic providers (MiniMax, DeepSeek, Qwen, GLM, Kimi) get
        // the correct apiFormat + modelCompat flags. Without these,
        // the Stage 1 extractor may misparse reasoning content.
        const runtime = toRuntimeConfigFromLegacy(provider, model);
        llmClient = createAIClientWithRetry({
          apiKey: provider.apiKey,
          baseURL: provider.baseUrl,
          model,
          apiFormat: runtime.apiFormat,
          providerId: runtime.providerId,
          modelCapabilities: runtime.modelCompat,
        });
        // Credentials for the Phase 2 curator subprocess (orchestrator
        // spawns it via the shared agent process pool).
        curationProviderConfig = {
          apiKey: provider.apiKey,
          model,
          baseUrl: provider.baseUrl,
          provider: llmProvider,
        };
      }
    } catch (llmErr) {
      logger.warn('Memory worker: LLM client construction failed; extraction disabled', { error: llmErr instanceof Error ? llmErr.message : String(llmErr) }, LogComponent.DB);
    }

    if (!llmClient) {
      logger.warn('Memory worker: no LLM client; worker not started', undefined, LogComponent.DB);
      return 'no-llm';
    }

    // Phase 2 curation wiring (Plan 406): without these deps every
    // curation tick is silently skipped (skipped_no_curation_deps).
    // The curator works directly on the live memory root (simplified
    // flow, 2026-08-09); a git backup is taken before each run.
    const os = await import('os');
    const memoryRoot = path.join(os.homedir(), '.duya', 'memory');

    // RAG index refresh (plan 428): rebuild the retrievable memory
    // index after each successful curation run. Enabled via
    // `[memory.rag].enabled`; the embedding client resolves through
    // the provider framework (falling back to keyword-only when the
    // provider has no embeddings endpoint). Shared executor built in
    // `memory/rag_refresh.ts` (also used by CLI / Settings rebuild).
    // Wrapped to discard the RagRefreshResult: CurationWorkerDeps
    // declares `ragRefresh?: (memoryRoot) => Promise<void>`.
    let ragRefresh: ((memoryRoot: string) => Promise<void>) | undefined;
    try {
      const executor = createRagIndexExecutor();
      if (executor?.refresh) {
        const refresh = executor.refresh.bind(executor);
        ragRefresh = async (memoryRoot: string) => {
          await refresh(memoryRoot);
        };
      }
    } catch (ragErr) {
      logger.warn(
        'RAG index refresh setup failed; disabled',
        { error: ragErr instanceof Error ? ragErr.message : String(ragErr) },
        LogComponent.DB,
      );
    }

    const curation = curationProviderConfig
      ? {
          configRoot: path.join(memoryRoot, 'memory-config'),
          providerConfig: curationProviderConfig,
          ragRefresh,
        }
      : undefined;

    // Ensure the curation config root exists with default files.
    if (curation) {
      try {
        await ensureMemoryConfigDir(curation.configRoot);
      } catch (initErr) {
        logger.warn(
          'Memory worker: config root init failed; curation may be skipped',
          { error: initErr instanceof Error ? initErr.message : String(initErr) },
          LogComponent.DB,
        );
      }
    }

    startMemoryWorker(
      {
        memoryDb,
        catalogSource,
        // The Memory extractor consumes the same paginated Host projection
        // as the Desktop session APIs; it does not reach into CoreStores.
        readMessageRows: readHostMessageRows,
        llmClient,
        curation,
      },
      // Phase 1 sweep every 5 min; low-power mode raises the tick
      // floor to 5s and throttles catalogSync to 5min.
      applyLowPowerOverrides(
        { extractEveryMs: 5 * 60_000, concurrency: 2 },
        isLowPowerEnabled(),
      ),
    );
    logger.info('Memory worker started (shadow mode)', { curation: curation ? 'wired' : 'disabled' }, LogComponent.DB);
    return 'started';
  } catch (error) {
    logger.warn('Failed to start memory worker', { error: error instanceof Error ? error.message : String(error) }, LogComponent.DB);
    return 'failed';
  }
}

/**
 * One-time boot alignment for the memory toggle (see module docblock).
 *
 * The renderer-facing toggle historically wrote ONLY the SQLite settings
 * table (`memoryEnabled` via db:setting:setJson), while every consumer
 * reads `memory.memory_enabled` from config.toml. Read the legacy value
 * through the authenticated Host Settings API. When the two stores disagree,
 * the UI value is the user's most recent intent — copy it into config.toml
 * before the worker gate / agent env bridges read it.
 *
 * Runs before the boot worker gate in main.ts. No-op when the legacy key
 * is absent (fresh installs) or both stores already agree.
 */
export async function syncMemoryToggleFromHostSettings(): Promise<void> {
  try {
    const storedValue = await getDesktopHostLocalSettingsApi().getSetting('memoryEnabled');
    let uiValue: unknown = null;
    if (storedValue !== null) {
      try {
        uiValue = JSON.parse(storedValue) as unknown;
      } catch {
        return;
      }
    }
    if (typeof uiValue !== 'boolean') return;
    const configStore = getConfigStore();
    const configValue = configStore.getByPath('memory.memory_enabled');
    if (configValue === uiValue) return;
    configStore.set('memory.memory_enabled', uiValue);
    logger.warn(
      'Memory toggle: config.toml disagreed with the UI setting — aligned to UI value',
      { uiValue, configValue },
      LogComponent.DB,
    );
  } catch (err) {
    logger.warn(
      'Memory toggle: boot alignment failed (worker gate falls back to config.toml)',
      { error: err instanceof Error ? err.message : String(err) },
      LogComponent.DB,
    );
  }
}
