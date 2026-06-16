import { describe, it, expect } from 'vitest'
import { ProgressTracker, RECENT_ACTIVITIES_CAP } from '../../../src/lifecycle/ProgressTracker.js'

describe('ProgressTracker.initial', () => {
  it('returns a snapshot with all counters at zero', () => {
    const t = 1700000000000
    const snap = ProgressTracker.initial(t)
    expect(snap.toolUseCount).toBe(0)
    expect(snap.cumulativeOutputTokens).toBe(0)
    expect(snap.cumulativeInputTokens).toBe(0)
    expect(snap.lastActivity).toBeNull()
    expect(snap.recentActivities).toEqual([])
    expect(snap.startedAt).toBe(t)
    expect(snap.lastUpdateAt).toBe(t)
  })

  it('exports a cap constant', () => {
    expect(RECENT_ACTIVITIES_CAP).toBe(5)
  })
})

describe('ProgressTracker.recordToolUse', () => {
  it('returns a NEW object (immutability)', () => {
    const snap = ProgressTracker.initial(1000)
    const next = ProgressTracker.recordToolUse(snap, 'Read', 'foo.ts', 2000)
    expect(next).not.toBe(snap)
    expect(snap.toolUseCount).toBe(0) // original unchanged
    expect(next.toolUseCount).toBe(1)
  })

  it('caps recentActivities at 5 by dropping oldest', () => {
    let snap = ProgressTracker.initial(1000)
    for (let i = 0; i < 8; i++) {
      snap = ProgressTracker.recordToolUse(snap, 'Read', `f${i}`, 2000 + i)
    }
    expect(snap.recentActivities).toHaveLength(5)
    expect(snap.recentActivities[0].description).toBe('f3')
    expect(snap.recentActivities[4].description).toBe('f7')
  })

  it('updates lastActivity to the most recent tool use', () => {
    const snap = ProgressTracker.initial(1000)
    const next = ProgressTracker.recordToolUse(snap, 'Bash', 'ls', 5000)
    expect(next.lastActivity).toEqual({ tool: 'Bash', description: 'ls', at: 5000 })
  })
})

describe('ProgressTracker.recordTokenUsage', () => {
  it('accumulates input and output tokens', () => {
    let snap = ProgressTracker.initial(1000)
    snap = ProgressTracker.recordTokenUsage(snap, 100, 50, 2000)
    snap = ProgressTracker.recordTokenUsage(snap, 200, 80, 3000)
    expect(snap.cumulativeInputTokens).toBe(300)
    expect(snap.cumulativeOutputTokens).toBe(130)
  })

  it('returns a NEW object (immutability)', () => {
    const snap = ProgressTracker.initial(1000)
    const next = ProgressTracker.recordTokenUsage(snap, 10, 5, 2000)
    expect(next).not.toBe(snap)
    expect(snap.cumulativeInputTokens).toBe(0)
  })
})