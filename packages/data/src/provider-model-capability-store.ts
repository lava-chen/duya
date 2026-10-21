import type { ProviderModelCapabilityRecord } from '@duya/agent-protocol/model-capabilities';
import type { SqliteDatabase } from './sqlite-connection.js';

interface ProviderModelCapabilityRow {
  readonly provider_id: string;
  readonly model_id: string;
  readonly display_name: string | null;
  readonly context_window: number | null;
  readonly max_output_tokens: number | null;
  readonly supports_tool_use: number | null;
  readonly supports_vision: number | null;
  readonly supports_reasoning: number | null;
  readonly supports_prompt_cache: number | null;
  readonly pricing_input_per_million: number | null;
  readonly pricing_output_per_million: number | null;
  readonly pricing_cache_read_per_million: number | null;
  readonly pricing_cache_write_per_million: number | null;
  readonly pricing_currency: string | null;
  readonly source: ProviderModelCapabilityRecord['source'];
  readonly updated_at: number;
}

/** Persistence for provider/model capability overrides in `duya-main.db`. */
export class ProviderModelCapabilityStore {
  constructor(private readonly db: SqliteDatabase) {}

  listByProvider(providerId: string): ProviderModelCapabilityRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM provider_model_capabilities WHERE provider_id = ? ORDER BY model_id',
    ).all(providerId) as ProviderModelCapabilityRow[];
    return rows.map(rowToCapability);
  }

  getOne(providerId: string, modelId: string): ProviderModelCapabilityRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM provider_model_capabilities WHERE provider_id = ? AND model_id = ?',
    ).get(providerId, modelId) as ProviderModelCapabilityRow | undefined;
    return row ? rowToCapability(row) : null;
  }

  upsert(capability: ProviderModelCapabilityRecord): ProviderModelCapabilityRecord {
    const stored = { ...capability, updatedAt: Date.now() };
    this.db.prepare(`
      INSERT INTO provider_model_capabilities (
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
        updated_at = excluded.updated_at
    `).run(
      stored.providerId,
      stored.modelId,
      stored.displayName ?? null,
      stored.contextWindow ?? null,
      stored.maxOutputTokens ?? null,
      stored.supportsToolUse == null ? null : stored.supportsToolUse ? 1 : 0,
      stored.supportsVision == null ? null : stored.supportsVision ? 1 : 0,
      stored.supportsReasoning == null ? null : stored.supportsReasoning ? 1 : 0,
      stored.supportsPromptCache == null ? null : stored.supportsPromptCache ? 1 : 0,
      stored.pricing?.inputPerMillion ?? null,
      stored.pricing?.outputPerMillion ?? null,
      stored.pricing?.cacheReadPerMillion ?? null,
      stored.pricing?.cacheWritePerMillion ?? null,
      stored.pricing?.currency ?? null,
      stored.source,
      stored.updatedAt,
    );
    return stored;
  }

  delete(providerId: string, modelId: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM provider_model_capabilities WHERE provider_id = ? AND model_id = ?',
    ).run(providerId, modelId);
    return result.changes > 0;
  }
}

function rowToCapability(row: ProviderModelCapabilityRow): ProviderModelCapabilityRecord {
  return {
    providerId: row.provider_id,
    modelId: row.model_id,
    ...(row.display_name ? { displayName: row.display_name } : {}),
    ...(row.context_window === null ? {} : { contextWindow: row.context_window }),
    ...(row.max_output_tokens === null ? {} : { maxOutputTokens: row.max_output_tokens }),
    ...(row.supports_tool_use === null ? {} : { supportsToolUse: row.supports_tool_use === 1 }),
    ...(row.supports_vision === null ? {} : { supportsVision: row.supports_vision === 1 }),
    ...(row.supports_reasoning === null ? {} : { supportsReasoning: row.supports_reasoning === 1 }),
    ...(row.supports_prompt_cache === null ? {} : { supportsPromptCache: row.supports_prompt_cache === 1 }),
    ...(row.pricing_input_per_million === null && row.pricing_output_per_million === null
      ? {}
      : {
          pricing: {
            ...(row.pricing_input_per_million === null ? {} : { inputPerMillion: row.pricing_input_per_million }),
            ...(row.pricing_output_per_million === null ? {} : { outputPerMillion: row.pricing_output_per_million }),
            ...(row.pricing_cache_read_per_million === null ? {} : { cacheReadPerMillion: row.pricing_cache_read_per_million }),
            ...(row.pricing_cache_write_per_million === null ? {} : { cacheWritePerMillion: row.pricing_cache_write_per_million }),
            ...(row.pricing_currency ? { currency: row.pricing_currency } : {}),
          },
        }),
    source: row.source,
    updatedAt: row.updated_at,
  };
}
