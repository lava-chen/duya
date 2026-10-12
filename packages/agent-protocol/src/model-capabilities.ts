export interface ModelCapabilityRecord {
  readonly id: string;
  readonly is_multimodal: number;
  readonly detected_at: number;
  readonly detection_method: string;
}

export interface ModelCapabilityWriteInput {
  readonly modelName: string;
  readonly isMultimodal: boolean;
  readonly method?: string;
}

/** Local-only access to the cached model capability registry. */
export interface HostLocalModelCapabilityApiV1 {
  getModelCapability(modelName: string): Promise<ModelCapabilityRecord | null>;
  setModelCapability(input: ModelCapabilityWriteInput): Promise<{ readonly success: true }>;
  deleteModelCapability(modelName: string): Promise<{ readonly success: boolean }>;
}

export type ProviderModelCapabilitySource = 'preset' | 'models-api' | 'user' | 'probe';

/** Persisted provider/model override used by runtime configuration and model UI. */
export interface ProviderModelCapabilityRecord {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly supportsToolUse?: boolean;
  readonly supportsVision?: boolean;
  readonly supportsReasoning?: boolean;
  readonly supportsPromptCache?: boolean;
  readonly reasoningEffortOptions?: readonly string[];
  readonly isLoaded?: boolean;
  readonly pricing?: {
    readonly inputPerMillion?: number;
    readonly outputPerMillion?: number;
    readonly cacheReadPerMillion?: number;
    readonly cacheWritePerMillion?: number;
    readonly currency?: string;
  };
  readonly source: ProviderModelCapabilitySource;
  readonly updatedAt: number;
}

/** Authenticated local Host API for provider/model capability persistence. */
export interface HostLocalProviderModelCapabilityApiV1 {
  listProviderModelCapabilities(providerId: string): Promise<readonly ProviderModelCapabilityRecord[]>;
  getProviderModelCapability(
    providerId: string,
    modelId: string,
  ): Promise<ProviderModelCapabilityRecord | null>;
  upsertProviderModelCapability(
    capability: ProviderModelCapabilityRecord,
  ): Promise<ProviderModelCapabilityRecord>;
  deleteProviderModelCapability(
    providerId: string,
    modelId: string,
  ): Promise<{ readonly success: boolean }>;
}
