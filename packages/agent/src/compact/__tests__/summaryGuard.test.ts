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

  // ─── Plan 523 P3: unclosed tags / control-token neutralization ───
  it('drops an unclosed <summary> open tag, preserving the body', () => {
    const raw = '<summary>\n1. Primary Request: build a thing\n2. Key Technical'
    const out = cleanSummaryText(raw)
    expect(out).not.toContain('<summary>')
    expect(out).toContain('1. Primary Request')
  })

  it('discards an unclosed <analysis> prefix up to the body start', () => {
    const raw = '<analysis>\nsome scratchpad reasoning\n\n1. Primary Request: build a thing'
    const out = cleanSummaryText(raw)
    expect(out).not.toContain('scratchpad')
    expect(out).toContain('1. Primary Request')
    expect(out.startsWith('1. Primary Request')).toBe(true)
  })

  it('neutralizes control tokens echoed in the body with zero-width spaces', () => {
    const raw = '<summary>\n... summarized ... remind me <summary> and <analysis> are wrappers'
    const out = cleanSummaryText(raw)
    expect(out).not.toContain('<summary>')
    expect(out).not.toContain('<analysis>')
    expect(out).toContain('wrappers')
  })

  it('keeps closed <summary>/<analysis> pair stripping behavior (regression)', () => {
    const raw = '<analysis>reason</analysis>\n<summary>1. Primary Request: x\n2. Key Technical</summary>'
    expect(cleanSummaryText(raw)).toBe('1. Primary Request: x\n2. Key Technical')
  })
})

describe('isDegenerateSummary', () => {
  it('flags a summary shorter than the minimum', () => {
    expect(isDegenerateSummary('short')).toBe(true)
  })

  it('flags the messages-truncated placeholder', () => {
    expect(isDegenerateSummary('[5 messages from earlier in the conversation]')).toBe(true)
  })

  it('flags a leak of DSML tool-invocation tokens even when long (Plan 523 F1)', () => {
    const dsm = `o<｜｜system::complete_o:${'>\\n<｜tool_call_begin:bash\\n'}${'x'.repeat(MIN_SUMMARY_CHARS)}`
    expect(isDegenerateSummary(dsm)).toBe(true)
    expect(isDegenerateSummary(`prompt<｜')${'>5kjq▓▓</｜'}${'x'.repeat(MIN_SUMMARY_CHARS)}`)).toBe(true)
  })

  it('flags a long one-line continuation / transcript echo with < 3 section headings (Plan 523 F2)', () => {
    const trunc = '1. Primary Request: build a thing\noutput was drowned in logs, rerun to see results only\n' +
      'x'.repeat(MIN_SUMMARY_CHARS)
    expect(isDegenerateSummary(trunc)).toBe(true)
  })

  it('accepts a long real summary with >= 3 section headings', () => {
    const long =
      '1. Primary Request: build it\n2. Key Technical: TS strict\n3. Files: src/a.ts\n' +
      '4. Errors: none\n5. Problem Solving: done\n6. All User: build it\n' +
      'x'.repeat(MIN_SUMMARY_CHARS)
    expect(isDegenerateSummary(long)).toBe(false)
  })

  it('accepts a long summary even without a <summary> wrapper', () => {
    const long =
      '1. Primary Request: build it\n2. Key Technical: TS strict\n3. Files: src/a.ts\n4. Errors: none\n\n' +
      'y'.repeat(MIN_SUMMARY_CHARS)
    expect(isDegenerateSummary(long)).toBe(false)
  })
})