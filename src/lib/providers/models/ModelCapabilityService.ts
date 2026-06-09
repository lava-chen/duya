/**
 * src/lib/providers/models/ModelCapabilityService.ts
 *
 * CRUD for per-model `ModelCapability` records.
 *
 * The model capability cache in `packages/agent/src/llm/model-capability-cache.ts`
 * stores a SQLite `is_multimodal` flag. This service is the in-memory facade
 * for the renderer; the agent runtime continues to own the persistent cache.
 *
 * Phase 1 intentionally implements an in-memory service. The agent runtime
 * can later be wired to push updates here.
 */

import type { ModelCapability } from '../types';

export class ModelCapabilityService {
  private capabilities: Map<string, ModelCapability> = new Map();
  private listeners: Set<(c: ModelCapability) => void> = new Set();

  private key(providerId: string, modelId: string): string {
    return `${providerId}::${modelId}`;
  }

  listModels(providerId: string): ModelCapability[] {
    const out: ModelCapability[] = [];
    for (const c of this.capabilities.values()) {
      if (c.providerId === providerId) out.push(c);
    }
    return out;
  }

  getModelCapability(
    providerId: string,
    modelId: string,
  ): ModelCapability | undefined {
    return this.capabilities.get(this.key(providerId, modelId));
  }

  upsertModelCapability(c: ModelCapability): void {
    const updated: ModelCapability = { ...c, updatedAt: Date.now() };
    this.capabilities.set(this.key(c.providerId, c.modelId), updated);
    for (const fn of this.listeners) {
      try {
        fn(updated);
      } catch {
        // ignore listener errors
      }
    }
  }

  /**
   * Merge static preset models into the capability store as
   * placeholder records (source = 'preset'). Useful for first-run
   * initialization when only model names are known.
   */
  mergePresetModels(
    providerId: string,
    presetModels: string[] | undefined,
    labels?: Record<string, string>,
  ): void {
    if (!presetModels) return;
    for (const modelId of presetModels) {
      const existing = this.getModelCapability(providerId, modelId);
      if (existing) continue;
      this.upsertModelCapability({
        providerId,
        modelId,
        displayName: labels?.[modelId] ?? modelId,
        source: 'preset',
        updatedAt: Date.now(),
      });
    }
  }

  updateContextWindow(
    providerId: string,
    modelId: string,
    contextWindow: number,
  ): void {
    const existing = this.getModelCapability(providerId, modelId);
    this.upsertModelCapability({
      providerId,
      modelId,
      displayName: existing?.displayName,
      contextWindow,
      maxOutputTokens: existing?.maxOutputTokens,
      supportsToolUse: existing?.supportsToolUse,
      supportsVision: existing?.supportsVision,
      supportsReasoning: existing?.supportsReasoning,
      supportsPromptCache: existing?.supportsPromptCache,
      pricing: existing?.pricing,
      source: 'user',
      updatedAt: Date.now(),
    });
  }

  onChange(cb: (c: ModelCapability) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
}

/** Process-wide singleton used by the renderer. */
export const modelCapabilityService = new ModelCapabilityService();
