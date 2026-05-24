export function createSignal(): {
  subscribe: (callback: () => void) => () => void
  emit: () => void
} {
  const listeners = new Set<() => void>()

  return {
    subscribe(callback) {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
    emit() {
      for (const listener of listeners) {
        try {
          listener()
        } catch {
          // silence listener errors
        }
      }
    },
  }
}