import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  classifyCompactFailure,
  classifySuppressReason,
  CompactSuppression,
  isRetryableCompactFailure,
  reasonToSuppressState,
  suppressReasonMessage,
  suppressReasonToString,
  suppressStateToString,
  SUPPRESS_NONE,
  SUPPRESS_TURN,
  SUPPRESS_STICKY,
  SUPPRESS_UNTIL_SUCCESS,
  SUPPRESS_AUTH,
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

describe('classifySuppressReason (grok-aligned)', () => {
  it('returns null on cancel/abort (not a fault of compaction)', () => {
    expect(classifySuppressReason(new Error('aborted'))).toBeNull()
    expect(classifySuppressReason(new Error('user cancelled'))).toBeNull()
  })

  it('classifies credit / spending block', () => {
    expect(classifySuppressReason(new Error('out of credits'))).toBe('credit')
    expect(classifySuppressReason(new Error('usage limit reached'))).toBe('credit')
    expect(classifySuppressReason(new Error('spending-limit'))).toBe('credit')
  })

  it('classifies context_length_exceeded as size (STICKY)', () => {
    expect(classifySuppressReason(new Error('context_length_exceeded'))).toBe('size')
    expect(classifySuppressReason(new Error('prompt_too_long'))).toBe('size')
  })

  it('classifies 401 / unauthorized as auth', () => {
    expect(classifySuppressReason(new Error('HTTP 401 unauthorized'))).toBe('auth')
    expect(classifySuppressReason(new Error('authentication failed'))).toBe('auth')
  })

  it('classifies invalid_request_error as schema (STICKY)', () => {
    expect(classifySuppressReason(new Error('invalid_request_error: foo'))).toBe('schema')
    expect(classifySuppressReason(new Error('bad request'))).toBe('schema')
  })

  it('classifies unknown 5xx / network as other (TURN)', () => {
    expect(classifySuppressReason(new Error('HTTP 500 server error'))).toBe('other')
    expect(classifySuppressReason(new Error('ECONNRESET'))).toBe('other')
  })
})

describe('reasonToSuppressState (grok scope table)', () => {
  it('size / schema → STICKY', () => {
    expect(reasonToSuppressState('size')).toBe(SUPPRESS_STICKY)
    expect(reasonToSuppressState('schema')).toBe(SUPPRESS_STICKY)
  })
  it('credit → UNTIL_SUCCESS', () => {
    expect(reasonToSuppressState('credit')).toBe(SUPPRESS_UNTIL_SUCCESS)
  })
  it('auth → AUTH', () => {
    expect(reasonToSuppressState('auth')).toBe(SUPPRESS_AUTH)
  })
  it('other → TURN', () => {
    expect(reasonToSuppressState('other')).toBe(SUPPRESS_TURN)
  })
})

describe('CompactSuppression (5-state machine)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts in NONE', () => {
    const s = new CompactSuppression()
    expect(s.getState()).toBe(SUPPRESS_NONE)
    expect(s.isActive()).toBe(false)
  })

  it('trySuppress upgrades NONE → state and ignores repeat calls', () => {
    const s = new CompactSuppression()
    expect(s.trySuppress('other')).toBe(true)
    expect(s.getState()).toBe(SUPPRESS_TURN)
    // Second failure during an active suppression must NOT downgrade.
    expect(s.trySuppress('credit')).toBe(false)
    expect(s.getState()).toBe(SUPPRESS_TURN)
  })

  it('clearOnTurnStart clears only TURN', () => {
    const s = new CompactSuppression()
    s.trySuppress('other')
    expect(s.clearOnTurnStart()).toBe(true)
    expect(s.getState()).toBe(SUPPRESS_NONE)
  })

  it('clearOnTurnStart does not clear STICKY (needs budget change)', () => {
    const s = new CompactSuppression()
    s.trySuppress('size')
    expect(s.clearOnTurnStart()).toBe(false)
    expect(s.getState()).toBe(SUPPRESS_STICKY)
  })

  it('clearOnBudgetChange clears only STICKY', () => {
    const s = new CompactSuppression()
    s.trySuppress('size')
    expect(s.clearOnBudgetChange()).toBe(true)
    expect(s.getState()).toBe(SUPPRESS_NONE)
  })

  it('clearOnBudgetChange does not clear TURN (handled at turn start)', () => {
    const s = new CompactSuppression()
    s.trySuppress('other')
    expect(s.clearOnBudgetChange()).toBe(false)
    expect(s.getState()).toBe(SUPPRESS_TURN)
  })

  it('clearOnSuccess clears TURN/STICKY/UNTIL_SUCCESS but not AUTH', () => {
    const sTurn = new CompactSuppression()
    sTurn.trySuppress('other')
    expect(sTurn.clearOnSuccess()).toBe(true)
    expect(sTurn.getState()).toBe(SUPPRESS_NONE)

    const sSticky = new CompactSuppression()
    sSticky.trySuppress('size')
    expect(sSticky.clearOnSuccess()).toBe(true)

    const sUntil = new CompactSuppression()
    sUntil.trySuppress('credit')
    expect(sUntil.clearOnSuccess()).toBe(true)

    const sAuth = new CompactSuppression()
    sAuth.trySuppress('auth')
    expect(sAuth.clearOnSuccess()).toBe(false)
    expect(sAuth.getState()).toBe(SUPPRESS_AUTH)
  })

  it('clearOnAuthRefresh clears only AUTH', () => {
    const s = new CompactSuppression()
    s.trySuppress('auth')
    expect(s.clearOnAuthRefresh()).toBe(true)
    expect(s.getState()).toBe(SUPPRESS_NONE)
  })

  it('reset() returns to NONE', () => {
    const s = new CompactSuppression()
    s.trySuppress('size')
    s.reset()
    expect(s.getState()).toBe(SUPPRESS_NONE)
    expect(s.getLastReason()).toBeNull()
  })

  it('getLastReason reports the most recent reason applied', () => {
    const s = new CompactSuppression()
    s.trySuppress('credit')
    expect(s.getLastReason()).toBe('credit')
    s.clearOnSuccess()
    expect(s.getLastReason()).toBeNull()
  })

  it('suppressReasonMessage returns a user-facing string per reason', () => {
    expect(suppressReasonMessage('auth')).toContain('re-authenticate')
    expect(suppressReasonMessage('size')).toContain('too large')
    expect(suppressReasonMessage('credit')).toContain('credits')
    expect(suppressReasonMessage('schema')).toContain("can't be summarized")
    expect(suppressReasonMessage('other')).toContain('retry on the next turn')
  })

  it('suppressReasonToString + suppressStateToString are stable', () => {
    expect(suppressReasonToString('size')).toBe('size')
    expect(suppressStateToString(SUPPRESS_STICKY)).toBe('sticky')
    expect(suppressStateToString(SUPPRESS_NONE)).toBe('none')
    expect(suppressStateToString(SUPPRESS_TURN)).toBe('turn')
    expect(suppressStateToString(SUPPRESS_UNTIL_SUCCESS)).toBe('until_success')
    expect(suppressStateToString(SUPPRESS_AUTH)).toBe('auth')
  })
})

describe('CompactSuppression legacy per-scope shim', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('suppress(scope) marks the machine active (any state)', () => {
    const s = new CompactSuppression()
    s.suppress('s', 1000)
    expect(s.isSuppressed('s', 1000)).toBe(true)
  })

  it('clear(scope) resets to NONE', () => {
    const s = new CompactSuppression()
    s.suppress('s', 1000)
    s.clear('s')
    expect(s.isSuppressed('s', 1000)).toBe(false)
  })

  it('SUPPRESS_WINDOW_MS is still exported for backwards-compat callers', () => {
    expect(typeof SUPPRESS_WINDOW_MS).toBe('number')
    expect(SUPPRESS_WINDOW_MS).toBeGreaterThan(0)
  })
})