import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import { readConfig, getConfigDatabasePath } from '../src/config'

// Mock fs module
vi.mock('fs')

describe('config', () => {
  const mockFs = vi.mocked(fs)
  
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('readConfig', () => {
    it('should return empty object when config file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false)
      
      const result = readConfig()
      
      expect(result).toEqual({})
    })

    it('should return empty object when config file cannot be read', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('Permission denied')
      })
      
      const result = readConfig()
      
      expect(result).toEqual({})
    })

    it('should return empty object when config file contains invalid JSON', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue('invalid json')
      
      const result = readConfig()
      
      expect(result).toEqual({})
    })

    it('should parse valid config file', () => {
      const config = { databasePath: '/custom/path/db.sqlite' }
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(config))
      
      const result = readConfig()
      
      expect(result).toEqual(config)
    })

    it('should handle empty config file', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue('{}')
      
      const result = readConfig()
      
      expect(result).toEqual({})
    })

    it('should handle config with additional properties', () => {
      const config = { 
        databasePath: '/path/db.sqlite',
        extraProperty: 'value'
      }
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(config))
      
      const result = readConfig()
      
      expect(result.databasePath).toBe('/path/db.sqlite')
    })
  })

  describe('getConfigDatabasePath', () => {
    it('should return undefined when no database path in config', () => {
      mockFs.existsSync.mockReturnValue(false)
      
      const result = getConfigDatabasePath()
      
      expect(result).toBeUndefined()
    })

    it('should return database path from config', () => {
      const config = { databasePath: '/custom/db.sqlite' }
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(config))
      
      const result = getConfigDatabasePath()
      
      expect(result).toBe('/custom/db.sqlite')
    })

    it('should return empty string when databasePath is empty string', () => {
      const config = { databasePath: '' }
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(config))
      
      const result = getConfigDatabasePath()
      
      expect(result).toBe('')
    })
  })
})
