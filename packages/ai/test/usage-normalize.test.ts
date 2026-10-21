import { describe, expect, it } from 'vitest'
import { normalizeUsage } from '../src/utils/usage'

describe('normalizeUsage — reasoning tokens', () => {
  it('returns undefined reasoning when provider does not report it', () => {
    const u = normalizeUsage({ input_tokens: 10, output_tokens: 5 })
    expect(u.reasoning).toBeUndefined()
    expect(u.output).toBe(5)
  })

  it('parses OpenAI completion_tokens_details.reasoning_tokens as a subset of output', () => {
    const u = normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      completion_tokens_details: { reasoning_tokens: 20 },
    })
    expect(u.reasoning).toBe(20)
    // reasoning ⊆ output: not an independent addition
    expect(u.output).toBe(50)
    expect(u.total).toBe(150)
  })

  it('accepts generic reasoning_tokens / reasoning aliases', () => {
    expect(normalizeUsage({ output_tokens: 9, reasoning_tokens: 4 }).reasoning).toBe(4)
    expect(normalizeUsage({ output_tokens: 9, reasoning: 3 }).reasoning).toBe(3)
  })
})

describe('normalizeUsage — Anthropic cache_creation TTL split', () => {
  it('sums ephemeral tiers into cacheWrite and exposes cacheWrite1h', () => {
    const u = normalizeUsage({
      input_tokens: 10,
      output_tokens: 5,
      cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 200 },
    })
    expect(u.cacheWrite).toBe(500)
    expect(u.cacheWrite1h).toBe(200)
  })

  it('keeps top-level cache_creation_input_tokens when no TTL split is present', () => {
    const u = normalizeUsage({
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 400,
    })
    expect(u.cacheWrite).toBe(400)
    expect(u.cacheWrite1h).toBeUndefined()
  })

  it('reports cacheWrite1h as 0 (explicitly reported) when both tiers are zero', () => {
    const u = normalizeUsage({
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 400,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    })
    // tierSum(0) must not clobber the top-level field
    expect(u.cacheWrite).toBe(400)
    // explicit 0 ≠ "not reported" (undefined) — the split IS reported
    expect(u.cacheWrite1h).toBe(0)
  })

  it('exposes a 1h-only split', () => {
    const u = normalizeUsage({
      input_tokens: 10,
      output_tokens: 5,
      cache_creation: { ephemeral_1h_input_tokens: 250 },
    })
    expect(u.cacheWrite).toBe(250)
    expect(u.cacheWrite1h).toBe(250)
  })
})
