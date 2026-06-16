import { logger } from '../utils/logger.js'

export type CleanupFn = () => Promise<void> | void

export class CleanupRegistry {
  private cleanups = new Set<CleanupFn>()
  private installed = false

  register(fn: CleanupFn): () => void {
    this.cleanups.add(fn)
    return () => { void this.cleanups.delete(fn) }
  }

  static install(): CleanupRegistry {
    const reg = new CleanupRegistry()
    const handler = () => {
      reg.fireAll('app_exit')
        .catch((err) => logger.warn('CleanupRegistry fireAll failed', { err }))
        .finally(() => process.exit(0))
    }
    process.once('SIGINT', handler)
    process.once('SIGTERM', handler)
    process.once('beforeExit', handler)
    reg.installed = true
    return reg
  }

  async fireAll(reason: 'app_exit' | 'manual'): Promise<void> {
    const fns = [...this.cleanups]
    await Promise.race([
      Promise.allSettled(fns.map((f) => {
        try { return Promise.resolve(f()).catch(() => undefined) }
        catch { return undefined }
      })),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ])
    if (reason === 'app_exit') {
      this.cleanups.clear()
    }
  }
}