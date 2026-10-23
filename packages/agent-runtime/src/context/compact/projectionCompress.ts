import type { Message } from '../types.js'
import { reformatTransform } from './transforms/reformatCompress.js'
import { offloadTransform } from './transforms/offloadCompress.js'
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
 * Build the default projection pipeline. Order is:
 *   reformat (grep/glob JSON → CSV) → offload (long read/bash bodies) →
 *   micro (recent-N-aware small tool cleanup) → image-truncation (drop old
 *   screenshots to bound token cost).
 */
export function buildDefaultTransforms(): readonly ProjectionTransform[] {
  return [
    reformatTransform,
    offloadTransform,
    microTransform,
    imageTruncationTransform,
  ]
}

/**
 * Back-compat alias for the default pipeline, frozen at module load.
 */
export const DEFAULT_TRANSFORMS: readonly ProjectionTransform[] = buildDefaultTransforms()

/**
 * Fold transforms in order over the model-facing message array. Returns the
 * input reference unchanged when no transform reports any work.
 *
 * - `transforms`: pass an explicit list to fully control the pipeline.
 *   When omitted, the env-driven default pipeline is used.
 */
export function compressProjectedToolMessages(
  messages: Message[],
  transforms?: readonly ProjectionTransform[],
): Message[] {
  const effective = transforms ?? buildDefaultTransforms()
  let current = messages
  for (const transform of effective) {
    current = transform.apply(current)
  }
  return current
}
