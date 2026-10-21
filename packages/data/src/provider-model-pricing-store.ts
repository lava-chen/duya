import type { HostLocalUsagePricingRecord } from '@duya/agent-protocol/usage-api';
import type { SqliteDatabase } from './sqlite-connection.js';

interface PricingRow {
  provider_id: string;
  model_id: string;
  pricing_input_per_million: number | null;
  pricing_output_per_million: number | null;
  pricing_cache_read_per_million: number | null;
  pricing_cache_write_per_million: number | null;
}

/** Read-only projection of provider model pricing used by usage summaries. */
export class ProviderModelPricingStore {
  constructor(private readonly db: SqliteDatabase) {}

  list(): HostLocalUsagePricingRecord[] {
    const rows = this.db.prepare(`
      SELECT provider_id, model_id, pricing_input_per_million,
        pricing_output_per_million, pricing_cache_read_per_million,
        pricing_cache_write_per_million
      FROM provider_model_capabilities
      WHERE pricing_input_per_million IS NOT NULL
        OR pricing_output_per_million IS NOT NULL
      ORDER BY provider_id, model_id
    `).all() as PricingRow[];

    return rows.map((row) => ({
      providerId: row.provider_id,
      modelId: row.model_id,
      ...(row.pricing_input_per_million === null
        ? {}
        : { inputPerMillion: row.pricing_input_per_million }),
      ...(row.pricing_output_per_million === null
        ? {}
        : { outputPerMillion: row.pricing_output_per_million }),
      ...(row.pricing_cache_read_per_million === null
        ? {}
        : { cacheReadPerMillion: row.pricing_cache_read_per_million }),
      ...(row.pricing_cache_write_per_million === null
        ? {}
        : { cacheWritePerMillion: row.pricing_cache_write_per_million }),
    }));
  }

  latestUpdatedAt(): number | null {
    const row = this.db.prepare(
      'SELECT MAX(updated_at) AS value FROM provider_model_capabilities',
    ).get() as { value: number | null } | undefined;
    return row?.value ?? null;
  }
}
