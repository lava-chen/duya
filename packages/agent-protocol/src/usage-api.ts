/** Session and pricing index consumed by local usage-summary clients. */
export interface HostLocalUsageSessionIndexItem {
  readonly id: string;
  readonly title: string;
  readonly model: string;
  readonly providerId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Append-only timeline count used as a cache version for derived facts. */
  readonly timelineVersion: number;
}

export interface HostLocalUsagePricingRecord {
  readonly providerId: string;
  readonly modelId: string;
  readonly inputPerMillion?: number;
  readonly outputPerMillion?: number;
  readonly cacheReadPerMillion?: number;
  readonly cacheWritePerMillion?: number;
}

export interface HostLocalUsageIndex {
  readonly sessions: readonly HostLocalUsageSessionIndexItem[];
  readonly pricing: readonly HostLocalUsagePricingRecord[];
  readonly pricingVersion?: string;
}

/** Local-only read API for usage-summary source data. */
export interface HostLocalUsageApiV1 {
  getUsageIndex(): Promise<HostLocalUsageIndex>;
}
