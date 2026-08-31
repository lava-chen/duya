import { describe, it, expect } from 'vitest'
import {
  LOCK_TTL_SEC,
  LOCK_RENEWAL_INTERVAL_MS,
  STREAM_IDLE_TIMEOUT_MS,
  FILE_UPLOAD_MAX_SIZE_BYTES,
  FILE_UPLOAD_ALLOWED_TYPES,
  FILE_UPLOAD_MAX_FILENAME_LENGTH,
  CONTEXT_COMPRESSION_MIN_MESSAGES,
  CONTEXT_COMPRESSION_THRESHOLD,
  SSE_KEEPALIVE_INTERVAL_MS,
  TOOL_TIMEOUT_SEC,
  TOOL_TIMEOUT_WARNING_SEC,
  PERMISSION_TIMEOUT_MS,
  HYDRATION_STALE_TIME_MS,
  DB_DEFAULT_MODEL,
} from '../constants'

describe('Constants', () => {
  describe('Session Locking', () => {
    it('should have correct lock TTL (5 minutes)', () => {
      expect(LOCK_TTL_SEC).toBe(300)
    })

    it('should have correct lock renewal interval (60 seconds)', () => {
      expect(LOCK_RENEWAL_INTERVAL_MS).toBe(60_000)
    })

    it('should have stream idle timeout less than lock TTL', () => {
      expect(STREAM_IDLE_TIMEOUT_MS).toBeLessThan(LOCK_TTL_SEC * 1000)
    })

    it('should have correct stream idle timeout (280 seconds)', () => {
      expect(STREAM_IDLE_TIMEOUT_MS).toBe(280_000)
    })
  })

  describe('File Upload', () => {
    it('should have correct max file size (10MB)', () => {
      expect(FILE_UPLOAD_MAX_SIZE_BYTES).toBe(10 * 1024 * 1024)
    })

    it('should have correct max filename length (255)', () => {
      expect(FILE_UPLOAD_MAX_FILENAME_LENGTH).toBe(255)
    })

    it('should allow common image types', () => {
      expect(FILE_UPLOAD_ALLOWED_TYPES.has('image/png')).toBe(true)
      expect(FILE_UPLOAD_ALLOWED_TYPES.has('image/jpeg')).toBe(true)
      expect(FILE_UPLOAD_ALLOWED_TYPES.has('image/gif')).toBe(true)
    })

    it('should allow text and code files', () => {
      expect(FILE_UPLOAD_ALLOWED_TYPES.has('text/plain')).toBe(true)
      expect(FILE_UPLOAD_ALLOWED_TYPES.has('application/json')).toBe(true)
      expect(FILE_UPLOAD_ALLOWED_TYPES.has('text/markdown')).toBe(true)
    })

    it('should not allow executable files', () => {
      expect(FILE_UPLOAD_ALLOWED_TYPES.has('application/exe')).toBe(false)
      expect(FILE_UPLOAD_ALLOWED_TYPES.has('application/x-msdownload')).toBe(false)
    })
  })

  describe('Context Compression', () => {
    it('should have correct minimum messages threshold (10)', () => {
      expect(CONTEXT_COMPRESSION_MIN_MESSAGES).toBe(10)
    })

    it('should have correct compression threshold (80%)', () => {
      expect(CONTEXT_COMPRESSION_THRESHOLD).toBe(0.8)
    })

    it('should have threshold between 0 and 1', () => {
      expect(CONTEXT_COMPRESSION_THRESHOLD).toBeGreaterThan(0)
      expect(CONTEXT_COMPRESSION_THRESHOLD).toBeLessThan(1)
    })
  })

  describe('SSE Streaming', () => {
    it('should have correct keepalive interval (30 seconds)', () => {
      expect(SSE_KEEPALIVE_INTERVAL_MS).toBe(30_000)
    })
  })

  describe('Tool Execution', () => {
    it('should have correct default timeout (5 minutes)', () => {
      expect(TOOL_TIMEOUT_SEC).toBe(300)
    })

    it('should have correct warning threshold (90 seconds)', () => {
      expect(TOOL_TIMEOUT_WARNING_SEC).toBe(90)
    })

    it('should have warning threshold less than timeout', () => {
      expect(TOOL_TIMEOUT_WARNING_SEC).toBeLessThan(TOOL_TIMEOUT_SEC)
    })
  })

  describe('Permission System', () => {
    it('should have correct permission timeout (5 minutes)', () => {
      expect(PERMISSION_TIMEOUT_MS).toBe(5 * 60 * 1000)
    })
  })

  describe('Sync & Hydration', () => {
    it('should have correct stale time (30 seconds)', () => {
      expect(HYDRATION_STALE_TIME_MS).toBe(30_000)
    })
  })

  describe('Default Model', () => {
    it('should have correct default model value', () => {
      expect(DB_DEFAULT_MODEL).toBe('claude-sonnet-4-20250514')
    })
  })
})
