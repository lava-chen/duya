/**
 * FileMemoryStore - Pure file-based memory storage
 *
 * Manages a single memory file (MEMORY.md or USER.md).
 * Implements the frozen snapshot pattern for prompt caching.
 *
 * Entry format:
 * ## summary § YYYY-MM-DD
 * content (optional)
 */

import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import {
  parseEntries,
  serializeEntries,
  serializeEntry,
  findEntryIndex,
  calculateTotalChars,
  formatUsage,
  type MemoryEntry,
} from './memoryParser.js'
import { scanContextContent } from '../security/contextScanner.js'

export interface MemoryResult {
  success: boolean
  entries?: MemoryEntry[]
  usage?: string
  error?: string
  message?: string
}

export interface FileMemoryStoreOptions {
  charLimit: number
}

/**
 * File-based memory store for a single file.
 */
export class FileMemoryStore {
  private _filePath: string
  private _charLimit: number
  private _entries: MemoryEntry[] = []
  private _snapshot: string = ''

  // Frozen snapshot for system prompt
  get snapshot(): string {
    return this._snapshot
  }

  constructor(filePath: string, options: FileMemoryStoreOptions) {
    this._filePath = filePath
    this._charLimit = options.charLimit
  }

  /**
   * Load entries from file and capture snapshot.
   * Synchronous — safe to call from constructors.
   */
  load(): void {
    this._ensureDirSync()
    this._entries = this._readFileSync()
    this._snapshot = this._renderBlock()
  }

  /**
   * Get prompt block for system injection.
   */
  buildPrompt(): string {
    return this._snapshot
  }

  /**
   * Get current entries.
   */
  list(): MemoryEntry[] {
    return [...this._entries]
  }

  /**
   * Get current usage string.
   */
  getUsage(): string {
    const current = calculateTotalChars(this._entries)
    return formatUsage(current, this._charLimit)
  }

  /**
   * Add a new entry.
   */
  async add(summary: string, content?: string, type?: MemoryEntry['type']): Promise<MemoryResult> {
    // Validate
    if (!summary.trim()) {
      return { success: false, error: 'summary is required' }
    }

    const trimmedSummary = summary.trim()

    // Duplicate detection: check if a similar entry already exists
    const duplicate = this._entries.find(e =>
      e.summary === trimmedSummary ||
      e.summary.toLowerCase().includes(trimmedSummary.toLowerCase()) ||
      trimmedSummary.toLowerCase().includes(e.summary.toLowerCase())
    )
    if (duplicate) {
      return {
        success: false,
        error: `A similar entry already exists: "${duplicate.summary}". Use replace to update it instead.`,
        entries: [...this._entries],
        usage: this.getUsage(),
      }
    }

    const entry: MemoryEntry = {
      summary: trimmedSummary,
      content: content?.trim() || undefined,
      timestamp: new Date().toISOString().split('T')[0],
      type,
    }

    // Calculate new total
    const testEntries = [...this._entries, entry]
    const newTotal = calculateTotalChars(testEntries)

    // Check limit
    if (newTotal > this._charLimit) {
      const current = calculateTotalChars(this._entries)
      return {
        success: false,
        error: `Memory at ${current.toLocaleString()}/${this._charLimit.toLocaleString()} chars. Adding this entry (${(summary.length + (content?.length || 0)).toLocaleString()} chars) would exceed the limit. Replace or remove existing entries first.`,
        entries: this._entries,
        usage: formatUsage(current, this._charLimit),
      }
    }

    // Add entry
    this._entries.push(entry)

    // Security scan before writing to disk
    const serialized = serializeEntry(entry)
    const scanResult = scanContextContent(serialized, path.basename(this._filePath))
    if (!scanResult.safe) {
      // Revert the in-memory add
      this._entries.pop()
      return {
        success: false,
        error: `Memory content blocked by security scanner: ${scanResult.findings.map(f => f.description).join(', ')}`,
        entries: [...this._entries],
        usage: this.getUsage(),
      }
    }

    // Write to disk
    await this._writeFile()

    return {
      success: true,
      entries: [...this._entries],
      usage: this.getUsage(),
      message: 'Entry added.',
    }
  }

  /**
   * Replace an entry by matching text.
   */
  async replace(oldText: string, newSummary?: string, newContent?: string): Promise<MemoryResult> {
    if (!oldText.trim()) {
      return { success: false, error: 'oldText is required for replace' }
    }

    const idx = findEntryIndex(this._entries, oldText)

    if (idx === -1) {
      return { success: false, error: `No entry found matching '${oldText}'` }
    }

    // Build updated entry
    const oldEntry = this._entries[idx]
    const updatedEntry: MemoryEntry = {
      summary: newSummary?.trim() || oldEntry.summary,
      content: newContent !== undefined ? (newContent.trim() || undefined) : oldEntry.content,
      timestamp: new Date().toISOString().split('T')[0],
    }

    // Calculate new total
    const testEntries = [...this._entries]
    testEntries[idx] = updatedEntry
    const newTotal = calculateTotalChars(testEntries)

    // Check limit
    if (newTotal > this._charLimit) {
      const current = calculateTotalChars(this._entries)
      return {
        success: false,
        error: `Updated content exceeds ${this._charLimit.toLocaleString()} char limit.`,
        entries: this._entries,
        usage: formatUsage(current, this._charLimit),
      }
    }

    // Replace entry
    this._entries[idx] = updatedEntry

    // Security scan before writing to disk
    const serialized = serializeEntry(updatedEntry)
    const scanResult = scanContextContent(serialized, path.basename(this._filePath))
    if (!scanResult.safe) {
      // Revert the in-memory replace
      this._entries[idx] = oldEntry
      return {
        success: false,
        error: `Memory content blocked by security scanner: ${scanResult.findings.map(f => f.description).join(', ')}`,
        entries: [...this._entries],
        usage: this.getUsage(),
      }
    }

    // Write to disk
    await this._writeFile()

    return {
      success: true,
      entries: [...this._entries],
      usage: this.getUsage(),
      message: 'Entry replaced.',
    }
  }

  /**
   * Remove an entry by matching text.
   */
  async remove(text: string): Promise<MemoryResult> {
    if (!text.trim()) {
      return { success: false, error: 'text is required for remove' }
    }

    const idx = findEntryIndex(this._entries, text)

    if (idx === -1) {
      return { success: false, error: `No entry found matching '${text}'` }
    }

    // Remove entry
    this._entries.splice(idx, 1)

    // Write to disk
    await this._writeFile()

    return {
      success: true,
      entries: [...this._entries],
      usage: this.getUsage(),
      message: 'Entry removed.',
    }
  }

  // ===========================================================================
  // Private helpers
  // ===========================================================================

  private _ensureDirSync(): void {
    const dir = path.dirname(this._filePath)
    fs.mkdirSync(dir, { recursive: true })
  }

  private _readFileSync(): MemoryEntry[] {
    try {
      const content = fs.readFileSync(this._filePath, 'utf-8')
      return parseEntries(content)
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        return []
      }
      throw err
    }
  }

  private async _writeFile(): Promise<void> {
    const content = serializeEntries(this._entries)

    // Atomic write: temp file + rename
    const dir = path.dirname(this._filePath)
    const tmp = path.join(dir, `.mem_${Date.now()}.tmp`)

    try {
      await fsp.writeFile(tmp, content, 'utf-8')
      await fsp.rename(tmp, this._filePath)
    } catch (err) {
      try {
        await fsp.unlink(tmp)
      } catch {
        // Temp file cleanup failed — non-critical, main error will propagate
      }
      throw err
    }
  }

  private _renderBlock(): string {
    if (this._entries.length === 0) {
      return ''
    }

    const current = calculateTotalChars(this._entries)
    const pct = Math.min(100, Math.floor((current / this._charLimit) * 100))

    // Determine header based on file name
    const filename = path.basename(this._filePath, '.md').toUpperCase()
    const header = `${filename} [${pct}% — ${current.toLocaleString()}/${this._charLimit.toLocaleString()} chars]`

    const separator = '═'.repeat(Math.min(46, header.length))

    const content = this._entries.map(e => {
      const ageStr = this._formatAge(e.timestamp)
      const line = serializeEntry(e)
      return `${line}  ${ageStr}`
    }).join('\n§\n')

    const maxAge = this._entries.reduce((max, e) => Math.max(max, this._entryAgeDays(e.timestamp)), 0)
    const stalenessNote = maxAge > 7
      ? `\n\n> ⚠ Some memories are ${maxAge} days old. Memories are point-in-time observations — verify against current state before acting on them.`
      : ''

    return `${separator}\n${header}\n${separator}\n${content}${stalenessNote}`
  }

  private _entryAgeDays(timestamp: string): number {
    const ts = new Date(timestamp).getTime()
    if (isNaN(ts)) return 0
    return Math.max(0, Math.floor((Date.now() - ts) / 86_400_000))
  }

  private _formatAge(timestamp: string): string {
    const d = this._entryAgeDays(timestamp)
    if (d === 0) return '*(today)*'
    if (d === 1) return '*(yesterday)*'
    return `*(${d}d ago)*`
  }
}
