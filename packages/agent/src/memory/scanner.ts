/**
 * Memory Content Scanner
 *
 * Wraps contextScanner for memory-specific threat detection.
 * All memory content is scanned before being saved to prevent prompt injection.
 */

import { scanContextContent, type ContextScanResult } from '../security/contextScanner.js'

const MEMORY_FILENAME = 'memory'

/**
 * Scan memory content for injection/exfiltration threats.
 * Throws if content is blocked.
 * Returns the content unchanged if safe.
 */
export function scanMemoryContent(content: string): string {
  const result: ContextScanResult = scanContextContent(content, MEMORY_FILENAME)

  if (!result.safe) {
    const blockedContent = result.blockedContent ?? '[BLOCKED: memory content contained potential prompt injection]'
    throw new MemoryScanError(
      result.findings.map(f => f.description || f.patternId).join(', '),
      blockedContent,
    )
  }

  return content
}

/**
 * Scan memory content and return the blocked replacement if unsafe.
 * Returns null if content is safe.
 */
export function scanMemoryContentForPrompt(
  content: string,
  filename: string = MEMORY_FILENAME,
): string | null {
  const result: ContextScanResult = scanContextContent(content, filename)

  if (!result.safe) {
    return result.blockedContent ?? `[BLOCKED: ${filename} contained potential prompt injection]`
  }

  return null
}

/**
 * Error thrown when memory content fails security scan.
 */
export class MemoryScanError extends Error {
  public readonly blockedContent: string

  constructor(
    public readonly reason: string,
    blockedContent: string,
  ) {
    super(`Memory scan failed: ${reason}`)
    this.blockedContent = blockedContent
    this.name = 'MemoryScanError'
  }
}
