import { vi } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

// Create temporary test directory
export const TEST_TMP_DIR = path.join(os.tmpdir(), 'duya-test-' + Date.now())

export function setupTestDir() {
  if (!fs.existsSync(TEST_TMP_DIR)) {
    fs.mkdirSync(TEST_TMP_DIR, { recursive: true })
  }
  return TEST_TMP_DIR
}

export function cleanupTestDir() {
  if (fs.existsSync(TEST_TMP_DIR)) {
    fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true })
  }
}

// Mock console methods for cleaner test output
export function mockConsole() {
  const originalLog = console.log
  const originalError = console.error
  const originalWarn = console.warn

  beforeAll(() => {
    console.log = vi.fn()
    console.error = vi.fn()
    console.warn = vi.fn()
  })

  afterAll(() => {
    console.log = originalLog
    console.error = originalError
    console.warn = originalWarn
  })
}
