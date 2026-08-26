/**
 * AGENTS.md Manager
 *
 * Central orchestrator for AGENTS.md file loading with task-scoped snapshots.
 * Refreshes at prompt-build boundaries while preserving stable prompt content
 * when the effective instruction set has not changed.
 */

import * as fs from 'fs'
import type { AgentsFileInfo, AgentsMdConfig } from './types.js'
import { DEFAULT_AGENTS_MD_CONFIG } from './types.js'
import { loadAgentsMdFiles, buildAgentsMdPrompt } from './loader.js'
import {
  collectNestedMemoryFiles,
} from './nested-loader.js'
import { logger } from '../utils/logger.js'

// =============================================================================
// AgentsMd Manager
// =============================================================================

export class AgentsMdManager {
  // Current task snapshot for system prompt
  private _snapshot: AgentsFileInfo[] = []
  private _snapshotPrompt: string = ''

  // Configuration
  private _config: AgentsMdConfig

  // Project path for the current snapshot
  private _projectPath: string = ''

  // Initialized flag
  private _initialized: boolean = false

  // Fast-path mtime cache: skip loadAgentsMdFiles when the same path's
  // tracked files have unchanged mtimes. Avoids repeated disk traversal
  // (cwd → root) on every prompt-build boundary.
  private _lastScanPath: string | undefined
  private _lastFileMtimes: Map<string, number> = new Map()

  // Plan 408b: session-level set of nested memory files already injected.
  // Non-evicting on purpose — re-injecting the same AGENTS.md wastes window
  // (cc-haha loadedNestedMemoryPaths parity). Normalized paths only.
  private _loadedNestedPaths: Set<string> = new Set()

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
   * Kept for compatibility with callers that initialize once.
   */
  async loadForSession(projectPath: string): Promise<void> {
    await this.refreshForTask(projectPath)
  }

  /**
   * Refresh the resolved instruction snapshot at a task/prompt-build boundary.
   * Returns true only when the effective prompt changed.
   */
  async refreshForTask(projectPath: string): Promise<boolean> {
    // Fast path: same path and no tracked file mtime changed since last scan
    // → skip the full disk traversal (cwd → root) entirely.
    if (
      this._initialized &&
      this._lastScanPath === projectPath &&
      this._lastFileMtimes.size > 0
    ) {
      const mtimesUnchanged = await this._checkMtimesUnchanged()
      if (mtimesUnchanged) {
        return false
      }
    }

    const files = await loadAgentsMdFiles({
      cwd: projectPath,
      config: this._config,
    })
    const prompt = buildAgentsMdPrompt(files)
    const changed =
      !this._initialized ||
      this._projectPath !== projectPath ||
      this._snapshotPrompt !== prompt

    this._projectPath = projectPath

    this._snapshot = files
    this._snapshotPrompt = prompt

    this._initialized = true

    // Record mtimes for next fast-path check
    this._lastScanPath = projectPath
    this._lastFileMtimes = await this._collectFileMtimes(files)

    if (changed) {
      logger.info('Project instruction snapshot refreshed', {
        fileCount: files.length,
        typeCounts: this._getTypeCounts(),
      }, 'AgentsMd')
    }

    return changed
  }

  /**
   * Check whether any tracked AGENTS.md file has changed mtime since last scan.
   * Returns true if all mtimes are unchanged (fast path can skip reload).
   */
  private async _checkMtimesUnchanged(): Promise<boolean> {
    for (const [filePath, lastMtime] of this._lastFileMtimes) {
      try {
        const stat = await fs.promises.stat(filePath)
        if (stat.mtimeMs !== lastMtime) {
          return false
        }
      } catch {
        // File deleted or inaccessible → assume changed
        return false
      }
    }
    return true
  }

  /**
   * Collect mtimeMs for all loaded AGENTS.md files for fast-path change detection.
   */
  private async _collectFileMtimes(
    files: AgentsFileInfo[],
  ): Promise<Map<string, number>> {
    const mtimes = new Map<string, number>()
    for (const f of files) {
      if (f.path) {
        try {
          const stat = await fs.promises.stat(f.path)
          mtimes.set(f.path, stat.mtimeMs)
        } catch {
          // Skip inaccessible files
        }
      }
    }
    return mtimes
  }

  /**
   * Get the current task's AGENTS.md prompt for system prompt injection.
   */
  buildAgentsMdPrompt(): string {
    return this._snapshotPrompt
  }

  /**
   * Get the current AGENTS.md section for the system prompt (Plan 408 Phase 5).
   * The snapshot is already wrapped in <system-reminder> by buildAgentsMdPrompt.
   */
  buildAgentsMdSection(): string {
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
    this._lastScanPath = undefined
    this._lastFileMtimes = new Map()
    this._loadedNestedPaths = new Set()
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
  // Nested memory (Plan 408b)
  // ===========================================================================

  /**
   * Discover and return the delta of nested memory files for this turn's
   * trigger paths. Returned files are marked injected in the session-level
   * set so subsequent turns never see them again.
   */
  async collectNestedMemory(triggerPaths: readonly string[]): Promise<AgentsFileInfo[]> {
    if (!this._initialized || triggerPaths.length === 0) {
      return []
    }
    return collectNestedMemoryFiles({
      cwd: this._projectPath,
      triggerPaths,
      loadedPaths: this._loadedNestedPaths,
    })
  }

  /**
   * Render one injection block for nested memory files. Same envelope as
   * `buildAgentsMdPrompt` but without MEMORY_INSTRUCTION_PROMPT — that
   * preamble belongs to the eager first-load only. Empty input → ''.
   */
  renderNestedMemoryBlock(files: AgentsFileInfo[]): string {
    if (files.length === 0) return ''
    const memories = files
      .filter((f) => f.content)
      .map(
        (f) =>
          `Contents of ${f.path} (project instructions, nested directory):\n\n${f.content}`,
      )
    if (memories.length === 0) return ''
    return `<system-reminder>\n<project_instructions_spec>\n${memories.join('\n\n')}\n</project_instructions_spec>\n</system-reminder>`
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
