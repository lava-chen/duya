/**
 * Memory Tool - Persistent memory management tool
 *
 * Provides add/replace/remove/list operations for memory.
 * Supports two targets:
 * - 'global': ~/.duya/MEMORY.md and ~/.duya/USER.md
 * - 'project': {projectPath}/.duya/MEMORY.md
 *
 * Always visible - both user and agent can call it.
 */

import { BaseTool } from '../tool/BaseTool.js'
import type { ToolResult } from '../tool/types.js'
import { getMemoryManager } from './manager.js'
import { z } from 'zod'

const TOOL_NAME = 'Memory'

const MEMORY_TOOL_DESCRIPTION = `Save durable information to persistent memory that survives across sessions.

WHEN TO SAVE (do this proactively, don't wait to be asked):
- User corrects you or says "remember this" / "don't do that again"
- User shares a preference, habit, or personal detail (name, role, timezone, coding style)
- You discover something about the environment (OS, installed tools, project structure)
- You learn a convention, API quirk, or workflow specific to this user's setup
- You identify a stable fact that will be useful again in future sessions

PRIORITY: User preferences and corrections > environment facts > procedural knowledge.
The most valuable memory prevents the user from having to repeat themselves.

Do NOT save: task progress, session outcomes, temporary TODO state, raw data dumps, or anything derivable via grep/git.

MEMORY TYPES (set via 'type' parameter):
- user: information about the user's role, preferences, knowledge
- feedback: corrections or confirmations about how to approach work
- project: ongoing work context, goals, bugs, incidents
- reference: pointers to resources in external systems

TWO STORES:
- 'global': ~/.duya/ — persists across all projects (memory + user)
- 'project': .duya/ in current project — project-specific memory

ACTIONS:
- add: Add a new memory entry (requires summary; optionally content and type)
- replace: Update an existing entry (requires oldText to match; optionally new summary/content)
- remove: Delete an entry (requires oldText to match)
- list: List all entries (optionally filter by type)

CHAR LIMITS: global memory 2,200 chars, global user 1,375 chars, project memory 2,200 chars.
When at limit, replace or remove existing entries before adding new ones.`

const MemoryInputSchema = z.object({
  action: z.enum(['add', 'replace', 'remove', 'list']),
  target: z.enum(['global', 'project']).optional().default('global'),
  subtarget: z.enum(['memory', 'user']).optional().default('memory'),
  summary: z.string().optional(),
  content: z.string().optional(),
  type: z.enum(['user', 'feedback', 'project', 'reference']).optional(),
  oldText: z.string().optional(),
})

type MemoryInput = z.infer<typeof MemoryInputSchema>

export class MemoryTool extends BaseTool {
  readonly name = TOOL_NAME
  readonly description = MEMORY_TOOL_DESCRIPTION

  readonly input_schema: z.ZodSchema = MemoryInputSchema

  async execute(
    input: Record<string, unknown>,
    workingDirectory?: string,
  ): Promise<ToolResult> {
    const parsed = MemoryInputSchema.safeParse(input)
    if (!parsed.success) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          success: false,
          error: `Invalid input: ${parsed.error.message}`,
        }),
        error: true,
      }
    }

    const { action, target, subtarget, summary, content, type, oldText } = parsed.data
    const manager = getMemoryManager()

    // If target is 'project' and no working directory, we can't proceed
    if (target === 'project' && !workingDirectory) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          success: false,
          error: 'project target requires workingDirectory',
        }),
        error: true,
      }
    }

    try {
      // Ensure manager is loaded for this project
      if (workingDirectory && !manager.isLoadedForPath(workingDirectory)) {
        await manager.loadForSession(workingDirectory)
      }

      const result = await manager.execute({
        action,
        target,
        subtarget,
        summary,
        content,
        type,
        oldText,
      })

      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify(result),
        error: !result.success,
      }
    } catch (error) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        }),
        error: true,
      }
    }
  }
}

// Singleton instance
let _memoryTool: MemoryTool | null = null

export function getMemoryTool(): MemoryTool {
  if (!_memoryTool) {
    _memoryTool = new MemoryTool()
  }
  return _memoryTool
}
