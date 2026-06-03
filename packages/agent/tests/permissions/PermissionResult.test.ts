import { describe, it, expect } from 'vitest'
import { getRuleBehaviorDescription } from '../../src/permissions/PermissionResult'

describe('PermissionResult', () => {
  describe('getRuleBehaviorDescription', () => {
    it('should return "allowed" for allow permission', () => {
      expect(getRuleBehaviorDescription('allow')).toBe('allowed')
    })

    it('should return "denied" for deny permission', () => {
      expect(getRuleBehaviorDescription('deny')).toBe('denied')
    })

    it('should return "asked for confirmation for" for ask permission', () => {
      expect(getRuleBehaviorDescription('ask')).toBe('asked for confirmation for')
    })

    it('should return "asked for confirmation for" for passthrough permission', () => {
      expect(getRuleBehaviorDescription('passthrough')).toBe('asked for confirmation for')
    })

    it('should handle all valid permission results', () => {
      const results = ['allow', 'deny', 'ask', 'passthrough'] as const
      results.forEach(result => {
        const description = getRuleBehaviorDescription(result)
        expect(typeof description).toBe('string')
        expect(description.length).toBeGreaterThan(0)
      })
    })
  })
})
