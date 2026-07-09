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
      // Copy the listener set before iterating so that listeners
      // which unsubscribe during emission do not mutate the set
      // being iterated (which would skip subsequent listeners).
      const snapshot = [...listeners]
      for (const listener of snapshot) {
        try {
          listener()
        } catch {
          // silence listener errors
        }
      }
    },
  }
}