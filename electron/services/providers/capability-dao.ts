/**
 * electron/services/providers/capability-dao.ts
 *
 * Phase 3: SQLite-backed ModelCapability persistence. The Electron
 * main process owns the canonical record; renderer reads/writes
 * via IPC.
 *
 * - `getDatabase()` is the existing connection (electron/db/connection.ts).
 * - The capability table lives in the same DB as chat sessions; it
 *   survives renderer reloads and is queryable by the agent runtime
 *   in a follow-up.
 * - We DO NOT delete rows for `source = 'preset'` / `'models-api'` /
 *   `'probe'` based on user edits; the user's `source = 'user'`
 *   record always wins for the (provider, model) pair.
 */

import type BetterSqlite3 from 'better-sqlite3';
import type { ModelCapability } from '../../../src/lib/providers/types';
import { getLogger, LogComponent } from '../../logging/logger';

const logger = getLogger();

interface Row {
  provider_id: string;
  model_id: string;
  display_name: string | null;
  context_window: number | null;
  max_output_tokens: number | null;
  supports_tool_use: number | null;
  supports_vision: number | null;
  supports_reasoning: number | null;
  supports_prompt_cache: number | null;
  pricing_input_per_million: number | null;
  pricing_output_per_million: number | null;
  pricing_cache_read_per_million: number | null;
  pricing_cache_write_per_million: number | null;
  pricing_currency: string | null;
  source: 'preset' | 'models-api' | 'user' | 'probe';
  updated_at: number;
}

function rowToCapability(r: Row): ModelCapability {
  const c: ModelCapability = {
    providerId: r.provider_id,
    modelId: r.model_id,
    source: r.source,
    updatedAt: r.updated_at,
  };
  if (r.display_name) c.displayName = r.display_name;
  if (r.context_window != null) c.contextWindow = r.context_window;
  if (r.max_output_tokens != null) c.maxOutputTokens = r.max_output_tokens;
  if (r.supports_tool_use != null) c.supportsToolUse = r.supports_tool_use === 1;
  if (r.supports_vision != null) c.supportsVision = r.supports_vision === 1;
  if (r.supports_reasoning != null) c.supportsReasoning = r.supports_reasoning === 1;
  if (r.supports_prompt_cache != null) c.supportsPromptCache = r.supports_prompt_cache === 1;
  if (
    r.pricing_input_per_million != null ||
    r.pricing_output_per_million != null
  ) {
    c.pricing = {
      ...(r.pricing_input_per_million != null
        ? { inputPerMillion: r.pricing_input_per_million }
        : {}),
      ...(r.pricing_output_per_million != null
        ? { outputPerMillion: r.pricing_output_per_million }
        : {}),
      ...(r.pricing_cache_read_per_million != null
        ? { cacheReadPerMillion: r.pricing_cache_read_per_million }
        : {}),
      ...(r.pricing_cache_write_per_million != null
        ? { cacheWritePerMillion: r.pricing_cache_write_per_million }
        : {}),
      ...(r.pricing_currency ? { currency: r.pricing_currency } : {}),
    };
  }
  return c;
}

export class CapabilityDao {
  private db: BetterSqlite3.Database | null;

  constructor(db: BetterSqlite3.Database | null) {
    this.db = db;
  }

  listByProvider(providerId: string): ModelCapability[] {
    if (!this.db) return [];
    const rows = this.db
      .prepare(
        'SELECT * FROM provider_model_capabilities WHERE provider_id = ? ORDER BY model_id',
      )
      .all(providerId) as Row[];
    return rows.map(rowToCapability);
  }

  getOne(providerId: string, modelId: string): ModelCapability | undefined {
    if (!this.db) return undefined;
    const row = this.db
      .prepare(
        'SELECT * FROM provider_model_capabilities WHERE provider_id = ? AND model_id = ?',
      )
      .get(providerId, modelId) as Row | undefined;
    return row ? rowToCapability(row) : undefined;
  }

  upsert(capability: ModelCapability): ModelCapability {
    if (!this.db) {
      // No DB available (e.g. tests); return the input unchanged.
      return { ...capability, updatedAt: Date.now() };
    }
    const now = Date.now();
    const c = { ...capability, updatedAt: now };
    this.db
      .prepare(
        `INSERT INTO provider_model_capabilities (
          provider_id, model_id, display_name, context_window,
          max_output_tokens, supports_tool_use, supports_vision,
          supports_reasoning, supports_prompt_cache,
          pricing_input_per_million, pricing_output_per_million,
          pricing_cache_read_per_million, pricing_cache_write_per_million,
          pricing_currency, source, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (provider_id, model_id) DO UPDATE SET
          display_name = excluded.display_name,
          context_window = excluded.context_window,
          max_output_tokens = excluded.max_output_tokens,
          supports_tool_use = excluded.supports_tool_use,
          supports_vision = excluded.supports_vision,
          supports_reasoning = excluded.supports_reasoning,
          supports_prompt_cache = excluded.supports_prompt_cache,
          pricing_input_per_million = excluded.pricing_input_per_million,
          pricing_output_per_million = excluded.pricing_output_per_million,
          pricing_cache_read_per_million = excluded.pricing_cache_read_per_million,
          pricing_cache_write_per_million = excluded.pricing_cache_write_per_million,
          pricing_currency = excluded.pricing_currency,
          source = excluded.source,
          updated_at = excluded.updated_at`,
      )
      .run(
        c.providerId,
        c.modelId,
        c.displayName ?? null,
        c.contextWindow ?? null,
        c.maxOutputTokens ?? null,
        c.supportsToolUse == null ? null : c.supportsToolUse ? 1 : 0,
        c.supportsVision == null ? null : c.supportsVision ? 1 : 0,
        c.supportsReasoning == null ? null : c.supportsReasoning ? 1 : 0,
        c.supportsPromptCache == null ? null : c.supportsPromptCache ? 1 : 0,
        c.pricing?.inputPerMillion ?? null,
        c.pricing?.outputPerMillion ?? null,
        c.pricing?.cacheReadPerMillion ?? null,
        c.pricing?.cacheWritePerMillion ?? null,
        c.pricing?.currency ?? null,
        c.source,
        c.updatedAt,
      );
    logger.debug(
      'CapabilityDao.upsert',
      { providerId: c.providerId, modelId: c.modelId, source: c.source },
      LogComponent.ConfigManager,
    );
    return c;
  }

  delete(providerId: string, modelId: string): boolean {
    if (!this.db) return false;
    const r = this.db
      .prepare(
        'DELETE FROM provider_model_capabilities WHERE provider_id = ? AND model_id = ?',
      )
      .run(providerId, modelId);
    return r.changes > 0;
  }
}
