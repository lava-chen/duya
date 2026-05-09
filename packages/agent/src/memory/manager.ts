/**
 * Memory Manager
 *
 * Central orchestrator for global + project memory system.
 * Implements the frozen snapshot pattern to preserve prompt caching.
 *
 * Memory content is frozen at session start and remains stable for the
 * entire session, even though file writes happen in real-time.
 */

import * as path from 'path'
import * as os from 'os'
import { FileMemoryStore, type MemoryResult } from './FileMemoryStore.js'
import { MEMORY_CHAR_LIMITS, type MemoryToolResult, type MemoryToolInput } from './types.js'
import { MemoryEntry } from './memoryParser.js'

// =============================================================================
// Memory Manager
// =============================================================================

export class MemoryManager {
  // Frozen snapshots for system prompt
  private _snapshot: {
    globalMemory: string
    globalUser: string
    projectMemory: string
  } = { globalMemory: '', globalUser: '', projectMemory: '' }

  // File stores
  private _globalMemoryStore: FileMemoryStore
  private _globalUserStore: FileMemoryStore
  private _projectStore: FileMemoryStore | null = null

  // Project path for this session
  private _projectPath: string = ''

  // Initialized flag
  private _initialized: boolean = false

  constructor() {
    // Initialize global stores
    const homeDir = os.homedir()
    this._globalMemoryStore = new FileMemoryStore(
      path.join(homeDir, '.duya', 'MEMORY.md'),
      { charLimit: MEMORY_CHAR_LIMITS.memory },
    )
    this._globalUserStore = new FileMemoryStore(
      path.join(homeDir, '.duya', 'USER.md'),
      { charLimit: MEMORY_CHAR_LIMITS.user },
    )
  }

  /**
   * Check if memory is already loaded for a specific project path.
   */
  isLoadedForPath(projectPath: string): boolean {
    return this._initialized && this._projectPath === projectPath
  }

  /**
   * Initialize the memory system for a session.
   * Captures frozen snapshots — called once at session start.
   * Synchronous: uses sync file reads so it's safe to call from constructors.
   */
  loadForSession(projectPath: string): void {
    this._projectPath = projectPath

    // Load global stores
    this._globalMemoryStore.load()
    this._globalUserStore.load()

    // Capture frozen snapshots for global memory
    this._snapshot = {
      globalMemory: this._globalMemoryStore.snapshot,
      globalUser: this._globalUserStore.snapshot,
      projectMemory: '',
    }

    // Load project store if .duya directory exists
    const projectDuyaDir = path.join(projectPath, '.duya')
    this._projectStore = new FileMemoryStore(
      path.join(projectDuyaDir, 'MEMORY.md'),
      { charLimit: MEMORY_CHAR_LIMITS.project },
    )

    try {
      this._projectStore.load()
      this._snapshot.projectMemory = this._projectStore.snapshot
    } catch {
      // Project memory doesn't exist yet, that's ok
      this._projectStore = null
    }

    this._initialized = true
  }

  // ===========================================================================
  // Snapshot Accessors (for system prompt)
  // ===========================================================================

  /**
   * Get frozen global memory block for system prompt injection.
   */
  buildGlobalMemoryPrompt(): string {
    return this._snapshot.globalMemory
  }

  /**
   * Get frozen global user block for system prompt injection.
   */
  buildGlobalUserPrompt(): string {
    return this._snapshot.globalUser
  }

  /**
   * Get frozen project memory block for system prompt injection.
   */
  buildProjectMemoryPrompt(): string {
    return this._snapshot.projectMemory
  }

  /**
   * Get both global memory blocks combined.
   */
  buildCombinedGlobalPrompt(): string {
    const parts: string[] = []
    if (this._snapshot.globalMemory) {
      parts.push(this._snapshot.globalMemory)
    }
    if (this._snapshot.globalUser) {
      parts.push(this._snapshot.globalUser)
    }
    return parts.join('\n\n')
  }

  /**
   * Get all memory blocks combined (global + project).
   */
  buildCombinedMemoryPrompt(): string {
    const parts: string[] = []
    if (this._snapshot.globalMemory) {
      parts.push(this._snapshot.globalMemory)
    }
    if (this._snapshot.globalUser) {
      parts.push(this._snapshot.globalUser)
    }
    if (this._snapshot.projectMemory) {
      parts.push(this._snapshot.projectMemory)
    }
    return parts.join('\n\n')
  }

  // ===========================================================================
  // Live State Accessors (for tool responses)
  // ===========================================================================

  /**
   * Get current global memory entries.
   */
  getGlobalMemoryEntries(): MemoryEntry[] {
    return this._globalMemoryStore.list()
  }

  /**
   * Get current global user entries.
   */
  getGlobalUserEntries(): MemoryEntry[] {
    return this._globalUserStore.list()
  }

  /**
   * Get current project memory entries.
   */
  getProjectMemoryEntries(): MemoryEntry[] | null {
    return this._projectStore?.list() ?? null
  }

  // ===========================================================================
  // Memory Operations
  // ===========================================================================

  /**
   * Execute a memory tool action.
   */
  async execute(input: MemoryToolInput): Promise<MemoryToolResult> {
    const { action, target = 'global', subtarget = 'memory', summary, content, type, oldText } = input

    // Select the appropriate store
    let store: FileMemoryStore
    let storeName: string

    if (target === 'project') {
      if (!this._projectStore) {
        return { success: false, error: 'Project memory not available' }
      }
      store = this._projectStore
      storeName = 'project'
    } else {
      // global
      store = subtarget === 'user' ? this._globalUserStore : this._globalMemoryStore
      storeName = subtarget
    }

    // Execute action
    switch (action) {
      case 'add': {
        if (!summary) {
          return { success: false, error: 'summary is required for add action' }
        }
        return await store.add(summary, content, type)
      }

      case 'replace': {
        if (!oldText) {
          return { success: false, error: 'oldText is required for replace action' }
        }
        return await store.replace(oldText, summary, content)
      }

      case 'remove': {
        if (!oldText) {
          return { success: false, error: 'oldText is required for remove action' }
        }
        return await store.remove(oldText)
      }

      case 'list': {
        const entries = store.list()
        return {
          success: true,
          entries,
          usage: store.getUsage(),
        }
      }

      default:
        return { success: false, error: `Unknown action: ${action}` }
    }
  }

  /**
   * Get usage for a specific target.
   */
  getUsage(target: 'global' | 'project', subtarget?: 'memory' | 'user'): string {
    if (target === 'project') {
      return this._projectStore?.getUsage() ?? '0/0 chars'
    }
    if (subtarget === 'user') {
      return this._globalUserStore.getUsage()
    }
    return this._globalMemoryStore.getUsage()
  }
}

// =============================================================================
// Default Instance
// =============================================================================

let _defaultManager: MemoryManager | null = null

export function getMemoryManager(): MemoryManager {
  if (!_defaultManager) {
    _defaultManager = new MemoryManager()
  }
  return _defaultManager
}

export function resetMemoryManager(): void {
  _defaultManager = null
}
