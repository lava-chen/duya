import { describe, it, expect } from 'vitest'
import { resolveCompactionContextWindow } from '../contextWindow.js'
import { DEFAULT_CONTEXT_WINDOW } from '../types.js'

describe('resolveCompactionContextWindow', () => {
  it('prefers an explicit runtime capability over the catalog', () => {
    // claude-sonnet-5 is a 1M catalog entry; the capability must still win
    // so config-marker / DB overrides keep taking effect.
    const r = resolveCompactionContextWindow({
      capabilityContextWindow: 64_000,
      modelId: 'claude-sonnet-5',
    })
    expect(r).toEqual({ contextWindow: 64_000, source: 'capability' })
  })

  it('falls back to the @duya/ai catalog when the capability is missing', () => {
    // Regression (plan 522): the plain chat path can arrive without a
    // capability row. Before the fix the budget collapsed to
    // DEFAULT_CONTEXT_WINDOW (200K), so a 1M model compacted at ~17% of
    // the window the context ring was displaying.
    const r = resolveCompactionContextWindow({
      capabilityContextWindow: undefined,
      modelId: 'claude-sonnet-5',
    })
    expect(r).toEqual({ contextWindow: 1_000_000, source: 'catalog' })
  })

  it('ignores a non-positive capability and uses the catalog', () => {
    const zero = resolveCompactionContextWindow({
      capabilityContextWindow: 0,
      modelId: 'claude-sonnet-5',
    })
    expect(zero).toEqual({ contextWindow: 1_000_000, source: 'catalog' })

    const negative = resolveCompactionContextWindow({
      capabilityContextWindow: -1,
      modelId: 'claude-sonnet-5',
    })
    expect(negative.source).toBe('catalog')
  })

  it('returns the 200K default only when both layers miss', () => {
    const r = resolveCompactionContextWindow({
      capabilityContextWindow: undefined,
      modelId: 'totally-unknown-model-id',
    })
    expect(r).toEqual({
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      source: 'default',
    })
    expect(DEFAULT_CONTEXT_WINDOW).toBe(200_000)
  })

  it('returns the default when no model id is supplied', () => {
    const r = resolveCompactionContextWindow({})
    expect(r).toEqual({
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      source: 'default',
    })
  })
})
