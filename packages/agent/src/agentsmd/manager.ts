/**
 * AGENTS.md Manager
 *
 * Central orchestrator for AGENTS.md file loading with frozen snapshot pattern.
 * Implements caching to preserve prompt caching behavior.
 */

import type { AgentsFileInfo, AgentsMdConfig } from './types.js'
import { DEFAULT_AGENTS_MD_CONFIG } from './types.js'
import { loadAgentsMdFiles, buildAgentsMdPrompt } from './loader.js'

// =============================================================================
// AgentsMd Manager
// =============================================================================

export class AgentsMdManager {
  // Frozen snapshot for system prompt
  private _snapshot: AgentsFileInfo[] = []
  private _snapshotPrompt: string = ''

  // Configuration
  private _config: AgentsMdConfig

  // Project path for this session
  private _projectPath: string = ''

  // Initialized flag
  private _initialized: boolean = false

  constructor(config?: Partial<AgentsMdConfig>) {
    this._config = {
      ...DEFAULT_AGENTS_MD_CONFIG,
      ...config,
    }
  }

  /**
   * Check if AGENTS.md is already loaded for a specific project path.
   */
  isLoadedForPath(projectPath: string): boolean {
    return this._initialized && this._projectPath === projectPath
  }

  /**
   * Initialize the AGENTS.md system for a session.
   * Captures frozen snapshots — called once at session start.
   */
  async loadForSession(projectPath: string): Promise<void> {
    this._projectPath = projectPath

    // Load all AGENTS.md files
    const files = await loadAgentsMdFiles({
      cwd: projectPath,
      config: this._config,
    })

    // Capture frozen snapshot
    this._snapshot = files
    this._snapshotPrompt = buildAgentsMdPrompt(files)

    this._initialized = true

    // Log summary
    const typeCounts = this._getTypeCounts()
    console.log(
      `[AgentsMd] Loaded ${files.length} files:`,
      Object.entries(typeCounts)
        .map(([type, count]) => `${type}=${count}`)
        .join(', '),
    )
  }

  /**
   * Get the frozen AGENTS.md prompt for system prompt injection.
   */
  buildAgentsMdPrompt(): string {
    return this._snapshotPrompt
  }

  /**
   * Get all loaded file info.
   */
  getLoadedFiles(): AgentsFileInfo[] {
    return [...this._snapshot]
  }

  /**
   * Get files by type.
   */
  getFilesByType(type: AgentsFileInfo['type']): AgentsFileInfo[] {
    return this._snapshot.filter(f => f.type === type)
  }

  /**
   * Get large files that exceed the size limit.
   */
  getLargeFiles(maxSize: number = this._config.maxFileSize): AgentsFileInfo[] {
    return this._snapshot.filter(f => f.content.length > maxSize)
  }

  /**
   * Check if there are any loaded files.
   */
  hasFiles(): boolean {
    return this._snapshot.length > 0
  }

  /**
   * Get the count of loaded files.
   */
  getFileCount(): number {
    return this._snapshot.length
  }

  /**
   * Get the total content size in characters.
   */
  getTotalContentSize(): number {
    return this._snapshot.reduce((sum, f) => sum + f.content.length, 0)
  }

  /**
   * Clear the snapshot and reset the manager.
   */
  reset(): void {
    this._snapshot = []
    this._snapshotPrompt = ''
    this._projectPath = ''
    this._initialized = false
  }

  /**
   * Update configuration.
   */
  updateConfig(config: Partial<AgentsMdConfig>): void {
    this._config = {
      ...this._config,
      ...config,
    }
  }

  /**
   * Get current configuration.
   */
  getConfig(): AgentsMdConfig {
    return { ...this._config }
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  private _getTypeCounts(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const file of this._snapshot) {
      counts[file.type] = (counts[file.type] ?? 0) + 1
    }
    return counts
  }
}

// =============================================================================
// Default Instance
// =============================================================================

let _defaultManager: AgentsMdManager | null = null

export function getAgentsMdManager(): AgentsMdManager {
  if (!_defaultManager) {
    _defaultManager = new AgentsMdManager()
  }
  return _defaultManager
}

export function resetAgentsMdManager(): void {
  _defaultManager = null
}

export function createAgentsMdManager(
  config?: Partial<AgentsMdConfig>,
): AgentsMdManager {
  return new AgentsMdManager(config)
}
