import { describe, it, expect, vi } from 'vitest'
import type { Message } from '../../types.js'
import { BackgroundPrefire, isPrefixFingerprint } from '../BackgroundPrefire.js'

function msg(id: string, content = `m-${id}`): Message {
  return { id, role: 'user', content, timestamp: 1 }
}

function ids(messages: Message[]): string[] {
  return messages.map((m) => m.id as string)
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

describe('isPrefixFingerprint', () => {
  it('accepts a strict prefix and rejects drift and overlong prefixes', () => {
    expect(isPrefixFingerprint(['a', 'b'], ['a', 'b', 'c'])).toBe(true)
    expect(isPrefixFingerprint(['a', 'x'], ['a', 'b', 'c'])).toBe(false)
    expect(isPrefixFingerprint(['a', 'b', 'c'], ['a', 'b'])).toBe(false)
    expect(isPrefixFingerprint([], ['a'])).toBe(false)
  })
})

describe('BackgroundPrefire', () => {
  it('starts a pass when usage crosses startFraction of the threshold', async () => {
    const prefire = new BackgroundPrefire({ prefireStartFraction: 0.75 })
    const summarize = vi.fn(async () => 'pass1 summary')
    const messages = [msg('a'), msg('b'), msg('c')]
    prefire.maybeStart(80, 100, messages, summarize)
    expect(prefire.isRunning()).toBe(true)
    await flushMicrotasks()
    expect(summarize).toHaveBeenCalledOnce()
    expect(prefire.hasFresh(messages)).toBe(true)
  })

  it('does not start below the threshold or when disabled', async () => {
    const summarize = vi.fn(async () => 'pass1')
    const off = new BackgroundPrefire({ prefireStartFraction: 0 })
    off.maybeStart(99, 100, [msg('a')], summarize)
    expect(off.isRunning()).toBe(false)

    const low = new BackgroundPrefire({ prefireStartFraction: 0.75 })
    low.maybeStart(70, 100, [msg('a')], summarize)
    expect(low.isRunning()).toBe(false)
    expect(summarize).not.toHaveBeenCalled()
  })

  it('does not restart while a pass is in flight', async () => {
    const prefire = new BackgroundPrefire({ prefireStartFraction: 0.75 })
    const summarize = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20))
      return 'pass1'
    })
    const messages = [msg('a'), msg('b')]
    prefire.maybeStart(90, 100, messages, summarize)
    await flushMicrotasks()
    expect(summarize).toHaveBeenCalledOnce()
    prefire.maybeStart(95, 100, messages, summarize)
    expect(summarize).toHaveBeenCalledOnce()
  })

  it('takeFresh returns the completed result and clears it', async () => {
    const prefire = new BackgroundPrefire({ prefireStartFraction: 0.75 })
    const messages = [msg('a'), msg('b')]
    prefire.maybeStart(90, 100, messages, async () => 'pass1 text')
    await flushMicrotasks()
    expect(await prefire.takeFresh(messages)).toBe('pass1 text')
    expect(await prefire.takeFresh(messages)).toBeUndefined()
  })

  it('takeFresh awaits an in-flight pass covering the current projection', async () => {
    const prefire = new BackgroundPrefire({ prefireStartFraction: 0.75 })
    const messages = [msg('a'), msg('b'), msg('c')]
    prefire.maybeStart(90, 100, messages, async () => {
      await new Promise((r) => setTimeout(r, 10))
      return 'late pass1'
    })
    // Compaction fires while the pass is still running; the projection grew
    // append-only, so the fingerprint is still a valid prefix.
    const grown = [...messages, msg('d')]
    expect(await prefire.takeFresh(grown)).toBe('late pass1')
  })

  it('discards the pass on prefix-invalid growth (prefix_invalid)', async () => {
    const prefire = new BackgroundPrefire({ prefireStartFraction: 0.75 })
    const messages = [msg('a'), msg('b')]
    prefire.maybeStart(90, 100, messages, async () => 'stale pass1')
    await flushMicrotasks()
    // A compaction rewrote the projection: the fingerprint no longer matches.
    const rewritten = [msg('summary'), msg('b')]
    expect(await prefire.takeFresh(rewritten)).toBeUndefined()
    expect(prefire.hasFresh(rewritten)).toBe(false)
  })

  it('a stale completed result does not block a fresh start', async () => {
    const prefire = new BackgroundPrefire({ prefireStartFraction: 0.75 })
    const summarize = vi.fn(async () => 'pass1')
    const first = [msg('a'), msg('b')]
    prefire.maybeStart(90, 100, first, summarize)
    await flushMicrotasks()
    // A compaction rewrote the timeline; usage climbs again.
    const rewritten = [msg('summary'), msg('b'), msg('c')]
    prefire.maybeStart(92, 100, rewritten, summarize)
    await flushMicrotasks()
    expect(summarize).toHaveBeenCalledTimes(2)
    expect(prefire.hasFresh(rewritten)).toBe(true)
  })

  it('swallows summarizer failures (best-effort pass)', async () => {
    const prefire = new BackgroundPrefire({ prefireStartFraction: 0.75 })
    const messages = [msg('a'), msg('b')]
    prefire.maybeStart(90, 100, messages, async () => {
      throw new Error('provider down')
    })
    await flushMicrotasks()
    expect(prefire.isRunning()).toBe(false)
    expect(await prefire.takeFresh(messages)).toBeUndefined()
  })

  it('clear() drops all state', async () => {
    const prefire = new BackgroundPrefire({ prefireStartFraction: 0.75 })
    const messages = [msg('a'), msg('b')]
    prefire.maybeStart(90, 100, messages, async () => 'pass1')
    await flushMicrotasks()
    prefire.clear()
    expect(prefire.hasFresh(messages)).toBe(false)
    expect(await prefire.takeFresh(messages)).toBeUndefined()
  })
})
