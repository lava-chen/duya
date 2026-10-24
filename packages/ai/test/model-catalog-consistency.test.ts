/**
 * Model directory consistency.
 *
 * The built-in directory (src/providers/*.models.ts) and the preset seeds
 * (src/providers/catalog-data.ts) are two halves of one fact: the preset id
 * is what a request carries, the directory entry is what tells duya how large
 * the window is, what the output ceiling is and which thinking tiers the
 * model takes. When the two drift apart the model still runs — it runs blind:
 * no context window, no effort ladder, no price.
 *
 * These checks exist so that drift cannot come back quietly:
 *  1. A preset with a static model list names a model the directory does not
 *     know. (Presets that enumerate their own models at runtime — the
 *     aggregators, the local runtimes — are exempt: their seed list is a
 *     fallback, not a claim about the built-in directory.)
 *  2. One exported list carries the same id twice, which makes the
 *     capability lookup depend on array order.
 *  3. A price is stored per token instead of per million tokens. The runtime
 *     reads Model.cost as `inputPerMillion` (provider-store), so a per-token
 *     price silently turns every cost estimate into zero.
 */
import { describe, it, expect } from 'vitest';
import { BUILTIN_CATALOG_ENTRIES } from '../src/providers/catalog.js';
import {
  allProviderModels,
  anthropicModels,
  bailianModels,
  bedrockModels,
  deepseekModels,
  glmAnthropicModels,
  glmModels,
  googleModels,
  kimiModels,
  minimaxCnModels,
  minimaxModels,
  ollamaModels,
  openAIModels,
  openaiResponsesModels,
  openrouterModels,
  qwenModels,
  stepfunModels,
  volcengineModels,
  xaiModels,
  xiaomiModels,
} from '../src/providers/index.js';

const directoryIds = new Set(allProviderModels.map((m) => m.id));

const EXPORTED_LISTS: Record<string, readonly { id: string }[]> = {
  anthropicModels,
  openAIModels,
  openaiResponsesModels,
  googleModels,
  deepseekModels,
  qwenModels,
  kimiModels,
  glmModels,
  glmAnthropicModels,
  minimaxModels,
  minimaxCnModels,
  xaiModels,
  stepfunModels,
  volcengineModels,
  bailianModels,
  bedrockModels,
  openrouterModels,
  ollamaModels,
  xiaomiModels,
};

describe('model directory consistency', () => {
  it('every static preset names a model the directory knows', () => {
    const unknown: string[] = [];
    for (const entry of BUILTIN_CATALOG_ENTRIES) {
      const source = entry.modelsSource ?? { type: 'static' };
      if (source.type !== 'static') continue;
      for (const model of entry.defaultModels) {
        if (!directoryIds.has(model.modelId)) {
          unknown.push(`${entry.id} → ${model.modelId}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it('no exported list carries the same id twice', () => {
    const duplicates: string[] = [];
    for (const [name, list] of Object.entries(EXPORTED_LISTS)) {
      const seen = new Set<string>();
      for (const model of list) {
        if (seen.has(model.id)) duplicates.push(`${name} → ${model.id}`);
        seen.add(model.id);
      }
    }
    expect(duplicates).toEqual([]);
  });

  it('prices are stored per million tokens, not per token', () => {
    // The cheapest model in the catalogue prices input at ~0.018 $/M; a
    // per-token number would be five orders of magnitude smaller.
    const perToken: string[] = [];
    for (const model of allProviderModels) {
      const cost = model.cost;
      if (!cost) continue;
      for (const [field, value] of [
        ['input', cost.input],
        ['output', cost.output],
      ] as const) {
        if (value > 0 && value < 0.01) perToken.push(`${model.id}.${field}=${value}`);
      }
    }
    expect(perToken).toEqual([]);
  });
});
