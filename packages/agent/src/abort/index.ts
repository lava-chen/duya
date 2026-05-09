/**
 * AbortController utilities for hierarchical signal propagation.
 */

export type AbortReason =
  | { type: 'user_interrupted' }
  | { type: 'sibling_error'; toolDescription: string }
  | { type: 'streaming_fallback' }

/**
 * Creates a child AbortController that aborts when the parent aborts.
 * If the parent is already aborted, the child is immediately aborted with the same reason.
 */
export function createChildAbortController(parent: AbortController): AbortController {
  const controller = new AbortController()

  if (parent.signal.aborted) {
    controller.abort(parent.signal.reason)
  } else {
    const handler = () => {
      controller.abort(parent.signal.reason)
    }
    parent.signal.addEventListener('abort', handler, { once: true })
  }

  return controller
}