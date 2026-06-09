/**
 * src/lib/providers/presets/index.ts
 *
 * Aggregates all preset modules into a single exported list.
 * Preserves backward-compatible named exports from the legacy
 * `src/lib/provider-presets.tsx` module via `legacy-shim.ts`.
 */

import type { ProviderPreset } from '../types';
import { ANTHROPIC_PRESETS } from './anthropic';
import { OPENAI_PRESETS } from './openai';
import { OLLAMA_PRESETS } from './ollama';
import { GOOGLE_PRESETS } from './google';
import { BEDROCK_PRESETS } from './bedrock';
import { CUSTOM_PRESETS } from './custom';

export const ALL_PRESETS: ProviderPreset[] = [
  ...ANTHROPIC_PRESETS,
  ...OPENAI_PRESETS,
  ...OLLAMA_PRESETS,
  ...GOOGLE_PRESETS,
  ...BEDROCK_PRESETS,
  ...CUSTOM_PRESETS,
];

export const PRESET_BY_KEY: Record<string, ProviderPreset> = Object.fromEntries(
  ALL_PRESETS.map((p) => [p.key, p]),
);

export function findPresetByKey(key: string): ProviderPreset | undefined {
  return PRESET_BY_KEY[key];
}

export function findPresetsByCategory(
  category: ProviderPreset['category'],
): ProviderPreset[] {
  return ALL_PRESETS.filter((p) => p.category === category);
}

export {
  ANTHROPIC_PRESETS,
  OPENAI_PRESETS,
  OLLAMA_PRESETS,
  GOOGLE_PRESETS,
  BEDROCK_PRESETS,
  CUSTOM_PRESETS,
};
