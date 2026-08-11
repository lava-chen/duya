import type { Message } from '../types.js'
import { reformatTransform } from './transforms/reformatCompress.js'
import { offloadTransform } from './transforms/offloadCompress.js'
import { canvasTransform } from './transforms/canvasTransform.js'
import { microTransform } from './transforms/microTransform.js'

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

/** Default pipeline order: content-aware first, position-gated fallbacks last. */
export const DEFAULT_TRANSFORMS: readonly ProjectionTransform[] = [
  reformatTransform,
  offloadTransform,
  canvasTransform,
  microTransform,
]

/**
 * Fold transforms in order over the model-facing message array. Returns the
 * input reference unchanged when no transform reports any work.
 */
export function compressProjectedToolMessages(
  messages: Message[],
  transforms: readonly ProjectionTransform[] = DEFAULT_TRANSFORMS,
): Message[] {
  let current = messages
  for (const transform of transforms) {
    current = transform.apply(current)
  }
  return current
}