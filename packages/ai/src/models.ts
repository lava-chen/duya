/**
 * packages/ai/src/models.ts
 *
 * Capability resolver: converts the user-level ThinkingLevel
 * to a model-supported level using Model.thinkingLevelMap.
 *
 * Spec §6.2: thinkingLevelMap semantics
 * - Missing key → use provider default (treated as supported)
 * - null value → level NOT supported
 * - string value → maps to provider-native level name
 */

import type { ApiFormat, Model, ModelCompat, ThinkingLevel, ModelThinkingLevel } from './types.js';
import { allProviderModels } from './providers/index.js';

const DEFAULT_LEVELS: ModelThinkingLevel[] = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
];

/**
 * Intensity weights used to find the nearest supported ThinkingLevel.
 *
 * xhigh is weighted closer to max than to high (gap 1 vs gap 2), because
 * "extra high" semantically approximates "maximum" thinking effort — when
 * a model supports high and max but not xhigh, clamping to max preserves
 * the user's intent better than clamping down to high.
 *
 * minimal/low/medium/high use uniform spacing (gap 1) so that equidistant
 * ties resolve downward (clamp down), matching the conservative default.
 */
const LEVEL_INTENSITY: Record<ThinkingLevel, number> = {
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 5,
  max: 6,
};

/**
 * Returns the list of thinking levels supported by the model.
 * - Non-reasoning models return [].
 * - Models with thinkingLevelMap return only levels whose value is not null
 *   and not undefined (missing keys are treated as unsupported here).
 * - Models without thinkingLevelMap return all default levels.
 */
export function getSupportedThinkingLevels(model: Model): ModelThinkingLevel[] {
  if (!model.reasoning) return [];
  if (!model.thinkingLevelMap) return [...DEFAULT_LEVELS];

  const supported: ModelThinkingLevel[] = [];
  for (const level of DEFAULT_LEVELS) {
    const mapped = model.thinkingLevelMap[level];
    if (mapped !== null && mapped !== undefined) {
      supported.push(level);
    }
  }
  return supported;
}

/**
 * Clamps a user-requested ThinkingLevel to the nearest supported level.
 *
 * - Returns undefined for non-reasoning models.
 * - Returns undefined when level is undefined or not a clampable ThinkingLevel
 *   (e.g. 'off', which disables thinking entirely).
 * - If the requested level is directly supported, returns it.
 * - Otherwise finds the nearest supported level by intensity distance.
 *   On tie, prefers the lower level (clamp down).
 */
export function clampThinkingLevel(
  model: Model,
  level: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
  if (!model.reasoning) return undefined;
  if (level === undefined) return undefined;

  const supported = getSupportedThinkingLevels(model).filter(
    (l): l is ThinkingLevel => l !== 'off',
  );
  if (supported.length === 0) return undefined;
  if (supported.includes(level)) return level;

  // Find the nearest supported level by intensity distance.
  // Strict < gives lower levels priority on ties (clamp down).
  const target = LEVEL_INTENSITY[level];
  let best: ThinkingLevel | undefined = undefined;
  let bestDist = Infinity;

  for (const s of supported) {
    const dist = Math.abs(LEVEL_INTENSITY[s] - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }

  return best;
}

/**
 * Returns the provider-native level string for a given Duya level.
 * - If thinkingLevelMap is undefined, returns the level itself.
 * - If the level maps to null, returns undefined (level not supported).
 * - If the level is missing from the map, returns undefined.
 * - Otherwise returns the mapped string.
 */
export function getNativeLevel(
  model: Model,
  level: ModelThinkingLevel,
): string | undefined {
  if (!model.thinkingLevelMap) return level;
  const mapped = model.thinkingLevelMap[level];
  return mapped === null ? undefined : mapped;
}

/**
 * Find the ModelCompat for a given apiFormat + modelId by looking up
 * the built-in provider preset models, optionally merging with
 * user-defined overrides. User values take precedence over built-in
 * preset values. Returns undefined if no match is found and no
 * overrides are provided (callers should fall back to protocol
 * defaults).
 *
 * Matching strategy:
 * 1. Match by `model.api === apiFormat && model.id === modelId`
 * 2. If multiple matches, prefer the one with `compat` defined
 * 3. If no match, return undefined (or just `overrides` if provided)
 *
 * Override merge:
 * - If only built-in compat exists, return it.
 * - If only overrides exist, return them.
 * - If both exist, merge with `{ ...builtIn, ...overrides }` so
 *   user values take precedence on a per-field basis.
 */
export function findModelCompat(
  apiFormat: ApiFormat,
  modelId: string,
  overrides?: ModelCompat,
): ModelCompat | undefined {
  const matches = allProviderModels.filter(
    m => m.api === apiFormat && m.id === modelId,
  );
  // Prefer a match that has compat flags defined
  const withCompat = matches.find(m => m.compat !== undefined);
  const source = withCompat ?? matches[0];
  let builtIn = source?.compat ? { ...source.compat } : undefined;

  // Model-targeted default (pi-mono governance): the catalog's output
  // ceiling flows to every consumer (agent turns, compaction, title, vision)
  // so a known model always runs at full output capability instead of the
  // 8192 protocol fallback. Explicit compat.maxOutputTokens wins.
  if (source?.maxTokens && builtIn?.maxOutputTokens === undefined) {
    builtIn = { maxOutputTokens: source.maxTokens, ...builtIn };
  }

  if (!overrides) return builtIn;
  if (!builtIn) return overrides;

  // Merge: user overrides take precedence over built-in
  return { ...builtIn, ...overrides };
}

/**
 * Find a Model by its id from the built-in provider preset models.
 * Returns the first match. If multiple providers use the same model id,
 * prefers the one with thinkingLevelMap defined.
 * Returns undefined if no match is found.
 */
export function findModelById(modelId: string): Model | undefined {
  const matches = allProviderModels.filter(m => m.id === modelId);
  const withMap = matches.find(m => m.thinkingLevelMap !== undefined);
  return withMap ?? matches[0];
}

/**
 * Returns the list of effort options for a given model id.
 * Each option has a `value` (the effort string, or '' for auto) and
 * a `level` (the ModelThinkingLevel, or 'off' for auto).
 *
 * Returns null if the model is not found or doesn't support reasoning.
 * The caller should fall back to the default 5 options in that case.
 */
export function getEffortOptionsForModel(
  modelId: string,
): Array<{ value: string; level: ModelThinkingLevel }> | null {
  const model = findModelById(modelId);
  if (!model || !model.reasoning) return null;

  const levels = getSupportedThinkingLevels(model);
  if (levels.length === 0) return null;

  // Always include 'off' (auto) as the first option
  const options: Array<{ value: string; level: ModelThinkingLevel }> = [
    { value: '', level: 'off' },
  ];

  for (const level of levels) {
    if (level === 'off') continue;
    options.push({ value: level, level });
  }

  return options;
}

/**
 * Capability-driven effort option builder for runtime-discovered
 * models. LM Studio reports a per-model `allowed_options` list
 * (normalized via `normalizeReasoningEffortOptions` into a
 * `string[]`). For models whose list lives in the runtime
 * capability record, this builder produces the matching effort
 * dropdown without needing a static catalog entry.
 *
 * Returns `null` when the capability is missing, the model does
 * not support reasoning, or the per-model options are absent.
 * Callers (MessageInput / SlashCommandPopover) MUST fall back to
 * `getEffortOptionsForModel(modelId)` in that case so static
 * catalog models (OpenAI / Anthropic / etc.) keep working.
 *
 * The returned shape matches `getEffortOptionsForModel` so callers
 * don't need to branch on the source. Unrecognized effort strings
 * (anything outside the canonical `ModelThinkingLevel` set) are
 * passed through verbatim with a synthetic level keyed off the
 * lowercase string — callers can map via `EFFORT_LABELS` or render
 * the raw token.
 */
export function getEffortOptionsForCapability(
  cap: {
    supportsReasoning?: boolean;
    reasoningEffortOptions?: string[];
  } | null | undefined,
): Array<{ value: string; level: ModelThinkingLevel }> | null {
  if (!cap || cap.supportsReasoning !== true) return null;
  const options = cap.reasoningEffortOptions;
  if (!Array.isArray(options) || options.length === 0) return null;

  const out: Array<{ value: string; level: ModelThinkingLevel }> = [
    { value: '', level: 'off' },
  ];
  for (const raw of options) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    // Coerce to a known ModelThinkingLevel where possible. Falls
    // back to the raw lowercase token so a model-specific effort
    // name (e.g. `'xhigh'`) still renders correctly.
    const known = (
      [
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ] as const
    ).find((l) => l === trimmed.toLowerCase());
    const level: ModelThinkingLevel = known ?? (trimmed.toLowerCase() as ModelThinkingLevel);
    out.push({ value: trimmed, level });
  }
  return out;
}
