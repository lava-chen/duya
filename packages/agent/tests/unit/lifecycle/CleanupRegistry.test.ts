import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CleanupRegistry } from '../../../src/lifecycle/CleanupRegistry.js'

describe('CleanupRegistry', () => {
  it('register returns an unregister function', async () => {
    const r = new CleanupRegistry()
    const fn = vi.fn()
    const un = r.register(fn)
    expect(r['cleanups'].has(fn)).toBe(true)
    un()
    expect(r['cleanups'].has(fn)).toBe(false)
  })

  it('fireAll awaits every registered cleanup', async () => {
    const r = new CleanupRegistry()
    const a = vi.fn().mockResolvedValue(undefined)
    const b = vi.fn().mockResolvedValue(undefined)
    r.register(a)
    r.register(b)
    await r.fireAll('manual')
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('fireAll enforces a 5s hard timeout (mock with fake timers)', async () => {
    vi.useFakeTimers()
    const r = new CleanupRegistry()
    const slow = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => setTimeout(resolve, 99999))
    )
    r.register(slow)
    const p = r.fireAll('app_exit')
    await vi.advanceTimersByTimeAsync(5000)
    await p
    expect(slow).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('fireAll tolerates a throwing cleanup', async () => {
    const r = new CleanupRegistry()
    r.register(() => { throw new Error('boom') })
    r.register(() => Promise.resolve())
    await expect(r.fireAll('manual')).resolves.toBeUndefined()
  })
})