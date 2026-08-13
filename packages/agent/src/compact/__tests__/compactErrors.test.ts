import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  classifyCompactFailure,
  CompactSuppression,
  isRetryableCompactFailure,
  SUPPRESS_WINDOW_MS,
} from '../compactErrors.js'

describe('classifyCompactFailure', () => {
  it('classifies abort as cancelled', () => {
    expect(classifyCompactFailure(new Error('operation aborted'))).toBe('cancelled')
  })

  it('classifies 4xx (except 408/429) as deterministic', () => {
    expect(classifyCompactFailure(new Error('HTTP 400 bad request'))).toBe('deterministic')
    expect(classifyCompactFailure(new Error('HTTP 401 unauthorized'))).toBe('deterministic')
  })

  it('classifies 408/429 as transient', () => {
    expect(classifyCompactFailure(new Error('HTTP 408 timeout'))).toBe('transient')
    expect(classifyCompactFailure(new Error('HTTP 429 rate limited'))).toBe('transient')
  })

  it('classifies context overflow as deterministic', () => {
    expect(classifyCompactFailure(new Error('context_length_exceeded'))).toBe('deterministic')
  })

  it('classifies 5xx and network errors as transient', () => {
    expect(classifyCompactFailure(new Error('HTTP 500 server error'))).toBe('transient')
    expect(classifyCompactFailure(new Error('ECONNRESET'))).toBe('transient')
  })
})

describe('isRetryableCompactFailure', () => {
  it('is true only for transient', () => {
    expect(isRetryableCompactFailure('transient')).toBe(true)
    expect(isRetryableCompactFailure('deterministic')).toBe(false)
    expect(isRetryableCompactFailure('cancelled')).toBe(false)
  })
})

describe('CompactSuppression', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is not suppressed initially', () => {
    expect(new CompactSuppression().isSuppressed('s')).toBe(false)
  })

  it('suppresses for the window then expires', () => {
    vi.useFakeTimers()
    const s = new CompactSuppression()
    s.suppress('s', 1000)
    expect(s.isSuppressed('s', 1000)).toBe(true)
    expect(s.isSuppressed('s', 1000 + SUPPRESS_WINDOW_MS - 1)).toBe(true)
    expect(s.isSuppressed('s', 1000 + SUPPRESS_WINDOW_MS + 1)).toBe(false)
  })

  it('clear removes suppression', () => {
    const s = new CompactSuppression()
    s.suppress('s', 1000)
    s.clear('s')
    expect(s.isSuppressed('s', 1000)).toBe(false)
  })
})