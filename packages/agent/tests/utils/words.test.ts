import { describe, it, expect, vi } from 'vitest'
import { generateWordSlug } from '../../src/utils/words'

describe('words utilities', () => {
  describe('generateWordSlug', () => {
    it('should generate slug with correct format', () => {
      const slug = generateWordSlug()
      const parts = slug.split('-')
      
      expect(parts).toHaveLength(3)
      expect(parts[0]).toBeDefined()
      expect(parts[1]).toBeDefined()
      expect(parts[2]).toMatch(/^\d+$/)
    })

    it('should generate different slugs on multiple calls', () => {
      const slug1 = generateWordSlug()
      const slug2 = generateWordSlug()
      
      // Very unlikely to be the same due to random number
      expect(slug1).not.toBe(slug2)
    })

    it('should include adjective as first part', () => {
      const adjectives = [
        'quick', 'bold', 'smart', 'bright', 'swift', 'keen', 'agile', 'steady',
        'clever', 'eager', 'nimble', 'witty', 'brave', 'calm', 'kind', 'wise',
      ]
      
      const slug = generateWordSlug()
      const firstPart = slug.split('-')[0]
      
      expect(adjectives).toContain(firstPart)
    })

    it('should include noun as second part', () => {
      const nouns = [
        'fox', 'eagle', 'lion', 'wolf', 'bear', 'hawk', 'deer', 'owl',
        'rabbit', 'tiger', 'falcon', 'raven', '豹', '狐', '鹰', '狼',
      ]
      
      const slug = generateWordSlug()
      const secondPart = slug.split('-')[1]
      
      expect(nouns).toContain(secondPart)
    })

    it('should include number as third part', () => {
      const slug = generateWordSlug()
      const thirdPart = slug.split('-')[2]
      const num = parseInt(thirdPart, 10)
      
      expect(num).toBeGreaterThanOrEqual(0)
      expect(num).toBeLessThan(1000)
    })

    it('should generate valid URL-friendly slugs', () => {
      const slug = generateWordSlug()
      
      // Should only contain lowercase letters, hyphens, and numbers
      expect(slug).toMatch(/^[a-z\u4e00-\u9fa5]+-[a-z\u4e00-\u9fa5]+-\d+$/)
    })

    it('should handle randomness correctly', () => {
      // Mock Math.random to test specific values
      const mockRandom = vi.spyOn(Math, 'random')
      
      mockRandom.mockReturnValueOnce(0) // First call for adjective
      mockRandom.mockReturnValueOnce(0) // Second call for noun
      mockRandom.mockReturnValueOnce(0) // Third call for number
      
      const slug = generateWordSlug()
      expect(slug).toBe('quick-fox-0')
      
      mockRandom.mockRestore()
    })

    it('should generate number less than 1000', () => {
      // Mock to get max value
      const mockRandom = vi.spyOn(Math, 'random')
      mockRandom.mockReturnValue(0.999)
      
      const slug = generateWordSlug()
      const num = parseInt(slug.split('-')[2], 10)
      
      expect(num).toBeLessThan(1000)
      
      mockRandom.mockRestore()
    })
  })
})
