import { describe, it, expect } from 'vitest'
import { cleanSummaryText, isDegenerateSummary, MIN_SUMMARY_CHARS } from '../summaryGuard.js'

describe('cleanSummaryText', () => {
  it('strips <analysis> blocks', () => {
    const raw = '<analysis>scratch</analysis>\n\n1. Primary Request: build a thing'
    expect(cleanSummaryText(raw)).not.toContain('scratch')
    expect(cleanSummaryText(raw)).toContain('1. Primary Request')
  })

  it('strips the <summary> wrapper tags', () => {
    const raw = '<summary>\n1. Primary Request: x\n</summary>'
    expect(cleanSummaryText(raw)).toBe('1. Primary Request: x')
  })

  it('collapses excess blank lines', () => {
    const raw = 'a\n\n\n\n\nb'
    expect(cleanSummaryText(raw)).toBe('a\n\nb')
  })
})

describe('isDegenerateSummary', () => {
  it('flags a summary shorter than the minimum', () => {
    expect(isDegenerateSummary('short')).toBe(true)
  })

  it('flags the messages-truncated placeholder', () => {
    expect(isDegenerateSummary('[5 messages from earlier in the conversation]')).toBe(true)
  })

  it('accepts a long real summary', () => {
    const long = '1. Primary Request: build it\n' + 'x'.repeat(MIN_SUMMARY_CHARS)
    expect(isDegenerateSummary(long)).toBe(false)
  })
})