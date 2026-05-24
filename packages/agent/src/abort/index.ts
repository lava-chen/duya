export type AbortReason =
  | { type: 'user_interrupted' }
  | { type: 'user_cancelled' }
  | { type: 'sibling_error'; toolDescription: string }
  | { type: 'streaming_fallback' }

const MAX_LISTENERS = 50

export function createAbortController(): AbortController {
  const controller = new AbortController()
  try {
    const signal = controller.signal as unknown as { setMaxListeners?: (n: number) => void }
    signal.setMaxListeners?.(MAX_LISTENERS)
  } catch {
    // setMaxListeners may not be available in all environments
  }
  return controller
}

export function createChildAbortController(parent: AbortController): AbortController {
  const controller = createAbortController()

  if (parent.signal.aborted) {
    controller.abort(parent.signal.reason)
    return controller
  }

  const parentRef = new WeakRef(parent)

  const handler = () => {
    controller.abort(parent.signal.reason)
    try {
      parent.signal.removeEventListener('abort', handler)
    } catch {
      // signal may already be too far gone
    }
  }

  parent.signal.addEventListener('abort', handler, { once: true })

  const childSignal = controller.signal as AbortSignal & { reason?: unknown }
  const childHandler = () => {
    try {
      const p = parentRef.deref()
      if (p) {
        p.signal.removeEventListener('abort', handler)
      }
    } catch {
      // parent already GC'd or signal is unreachable
    }
  }

  if ('addEventListener' in childSignal) {
    childSignal.addEventListener('abort', childHandler, { once: true })
  }

  return controller
}