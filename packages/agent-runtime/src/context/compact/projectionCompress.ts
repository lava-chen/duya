import type { Message } from '../types.js'
import { reformatTransform } from './transforms/reformatCompress.js'
import { offloadTransform } from './transforms/offloadCompress.js'
import { createCanvasTransform } from './transforms/canvasTransform.js'
import { microTransform } from './transforms/microTransform.js'
import { imageTruncationTransform } from './transforms/imageTruncationTransform.js'

/**
 * A projection-layer transform that rewrites the message array sent to the
 * LLM (NOT the persisted history). Transforms are pure: they return a new
 * array only when they change something, otherwise the same reference. They
 * never mutate their input or its message objects.
 */
export interface ProjectionTransform {
  readonly name: string
  apply(messages: Message[]): Message[]
}

/**
 * Env var name read once at module load to decide whether the canvas-history
 * transform runs. Centralised here so individual transforms never call
 * `process.env` themselves — callers that want to override the env-driven
 * default can pass `ProjectionPipelineConfig.canvasEnabled`.
 *
 * Default: enabled. Set `DUYA_COMPRESS_CANVAS_HISTORY=false` to disable.
 */
export const DUYA_COMPRESS_CANVAS_HISTORY_ENV = 'DUYA_COMPRESS_CANVAS_HISTORY'
const ENV_CANVAS_ENABLED = process.env[DUYA_COMPRESS_CANVAS_HISTORY_ENV] !== 'false'

/**
 * Configuration for the default projection pipeline. Callers that need to
 * override the env-driven default for one call can pass this as the third
 * argument to `compressProjectedToolMessages`. When omitted, env defaults apply.
 */
export interface ProjectionPipelineConfig {
  /**
   * Whether the canvas-history transform is enabled. `undefined` falls back to
   * the `DUYA_COMPRESS_CANVAS_HISTORY` env value (default true).
   */
  canvasEnabled?: boolean
}

/**
 * Build the default projection pipeline. Honours `config.canvasEnabled`
 * (falls back to `DUYA_COMPRESS_CANVAS_HISTORY`). Order is:
 *   reformat (grep/glob JSON → CSV) → offload (long read/bash bodies) →
 *   canvas (canvas_* history) → micro (recent-N-aware small tool cleanup)
 *   → image-truncation (drop old screenshots to bound token cost).
 */
export function buildDefaultTransforms(
  config: ProjectionPipelineConfig = {},
): readonly ProjectionTransform[] {
  const canvasEnabled = config.canvasEnabled ?? ENV_CANVAS_ENABLED
  return [
    reformatTransform,
    offloadTransform,
    createCanvasTransform({ enabled: canvasEnabled }),
    microTransform,
    imageTruncationTransform,
  ]
}

/**
 * Back-compat alias: env-driven default pipeline, frozen at module load.
 * Prefer `buildDefaultTransforms(config?)` when you need to override the
 * canvas switch per call.
 */
export const DEFAULT_TRANSFORMS: readonly ProjectionTransform[] = buildDefaultTransforms()

/**
 * Fold transforms in order over the model-facing message array. Returns the
 * input reference unchanged when no transform reports any work.
 *
 * - `transforms`: pass an explicit list to fully control the pipeline.
 *   When omitted, the env-driven default pipeline is used.
 * - `config`: only consulted when `transforms` is omitted. Pass it to override
 *   `DUYA_COMPRESS_CANVAS_HISTORY` per call without mutating env.
 */
export function compressProjectedToolMessages(
  messages: Message[],
  transforms?: readonly ProjectionTransform[],
  config?: ProjectionPipelineConfig,
): Message[] {
  const effective = transforms ?? buildDefaultTransforms(config)
  let current = messages
  for (const transform of effective) {
    current = transform.apply(current)
  }
  return current
}
