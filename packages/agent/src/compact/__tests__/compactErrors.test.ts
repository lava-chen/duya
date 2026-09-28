import { describe, it, expect } from 'vitest'
import {
  classifySuppressReason,
  classifyContextLengthError,
  suppressReasonMessage,
  SummaryDegenerateError,
} from '../compactErrors.js'

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

  it('classifies SummaryDegenerateError as other (TURN), not size/credit/auth/schema', () => {
    expect(classifySuppressReason(new SummaryDegenerateError(3, 500))).toBe('other')
  })
})

describe('suppressReasonMessage', () => {
  it('returns a user-facing string per reason', () => {
    expect(suppressReasonMessage('auth')).toContain('re-authenticate')
    expect(suppressReasonMessage('size')).toContain('too large')
    expect(suppressReasonMessage('credit')).toContain('credits')
    expect(suppressReasonMessage('schema')).toContain("can't be summarized")
    expect(suppressReasonMessage('other')).toContain('retry on the next turn')
  })
})

describe('SummaryDegenerateError', () => {
  it('carries attempts and lastChars for telemetry', () => {
    const err = new SummaryDegenerateError(3, 76)
    expect(err.name).toBe('SummaryDegenerateError')
    expect(err.attempts).toBe(3)
    expect(err.lastChars).toBe(76)
    expect(err.message).toContain('3 attempts')
  })
})

describe('classifyContextLengthError (plan 577 Phase 0 emergency gate)', () => {
  it('treats explicit provider context errors as self-sufficient evidence', () => {
    expect(classifyContextLengthError('context_length_exceeded')).toBe('explicit')
    expect(classifyContextLengthError('prompt_too_long')).toBe('explicit')
    expect(classifyContextLengthError('Context Window Exceeds Limit')).toBe('explicit')
    expect(
      classifyContextLengthError("This model's maximum context length is 200000 tokens"),
    ).toBe('explicit')
    expect(classifyContextLengthError('Context length exceeded: 210000 > 200000')).toBe('explicit')
    expect(classifyContextLengthError('Prompt is too long: 250000 tokens > 200000 maximum')).toBe(
      'explicit',
    )
    expect(classifyContextLengthError('input length exceeds model limit')).toBe('explicit')
    expect(classifyContextLengthError('Input tokens exceed the allowed maximum')).toBe('explicit')
    expect(classifyContextLengthError('Too many input tokens')).toBe('explicit')
    expect(classifyContextLengthError('request size exceeds the context window')).toBe('explicit')
  })

  it('treats generic "exceeds limit" wording as weak evidence only', () => {
    expect(classifyContextLengthError('max_tokens exceeds limit')).toBe('weak')
    expect(classifyContextLengthError('request payload exceeds the limit')).toBe('weak')
    expect(classifyContextLengthError('file size exceeds limit')).toBe('weak')
  })

  it('returns null for unrelated errors', () => {
    expect(classifyContextLengthError('HTTP 429 rate limit exceeded')).toBeNull()
    expect(classifyContextLengthError('ECONNRESET')).toBeNull()
    expect(classifyContextLengthError('unauthorized')).toBeNull()
    expect(classifyContextLengthError('')).toBeNull()
  })
})
