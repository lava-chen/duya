import { BaseTool } from '../tool/BaseTool.js'
import type { ToolResult } from '../tool/types.js'
import { getMemoryManager } from './manager.js'
import { z } from 'zod'

const TOOL_NAME = 'anchor_memory'

const ANCHOR_TOOL_DESCRIPTION = `Manage user-defined anchors — facts that persist across context compression cycles.

Anchors are durable constraints, decisions, preferences, and rules that the agent must always follow. Unlike regular memory (which can be compressed away during long conversations), anchors are pinned and survive compaction.

WHEN TO USE:
- User explicitly defines a rule or constraint ("always use tabs", "never modify .env files")
- A key architectural decision is made that all future work must respect
- User expresses a strong preference about coding style, tool usage, or workflow
- A critical constraint emerges that must survive the entire session

ANCHOR CATEGORIES:
- constraint: hard constraints the agent must never violate
- decision: important decisions made during the conversation
- preference: user preferences about style, tools, or workflow
- rule: project rules or conventions that must be followed

ACTIONS:
- add: Create a new anchor. Requires content (the anchor text) and category.
- remove: Delete an anchor by its id. Use list first to find ids.
- list: Show all current anchors with their ids.

Anchors are stored in ~/.duya/ANCHORS.md and persist across sessions.`

const AnchorInputSchema = z.object({
  action: z.enum(['add', 'remove', 'list']),
  content: z.string().optional().describe('The anchor content text (required for add)'),
  category: z.enum(['constraint', 'decision', 'preference', 'rule']).optional().describe('Category for new anchors'),
  id: z.string().optional().describe('Anchor id to remove (use list to find ids)'),
})

type AnchorInput = z.infer<typeof AnchorInputSchema>

export class AnchorTool extends BaseTool {
  readonly name = TOOL_NAME
  readonly description = ANCHOR_TOOL_DESCRIPTION

  readonly input_schema: z.ZodSchema = AnchorInputSchema

  async execute(
    input: Record<string, unknown>,
    workingDirectory?: string,
  ): Promise<ToolResult> {
    const parsed = AnchorInputSchema.safeParse(input)
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

    const { action, content, category, id } = parsed.data
    const manager = getMemoryManager()

    if (workingDirectory && !manager.isLoadedForPath(workingDirectory)) {
      manager.loadForSession(workingDirectory)
    }

    try {
      switch (action) {
        case 'add': {
          if (!content) {
            return {
              id: crypto.randomUUID(),
              name: this.name,
              result: JSON.stringify({ success: false, error: 'content is required for add action' }),
              error: true,
            }
          }
          if (!category) {
            return {
              id: crypto.randomUUID(),
              name: this.name,
              result: JSON.stringify({ success: false, error: 'category is required for add action' }),
              error: true,
            }
          }
          const result = await manager.addAnchor(content, category)
          return {
            id: crypto.randomUUID(),
            name: this.name,
            result: JSON.stringify(result),
            error: !result.success,
          }
        }
        case 'remove': {
          if (!id) {
            return {
              id: crypto.randomUUID(),
              name: this.name,
              result: JSON.stringify({ success: false, error: 'id is required for remove action' }),
              error: true,
            }
          }
          const result = await manager.removeAnchor(id)
          return {
            id: crypto.randomUUID(),
            name: this.name,
            result: JSON.stringify(result),
            error: !result.success,
          }
        }
        case 'list': {
          const result = manager.listAnchors()
          return {
            id: crypto.randomUUID(),
            name: this.name,
            result: JSON.stringify(result),
          }
        }
        default:
          return {
            id: crypto.randomUUID(),
            name: this.name,
            result: JSON.stringify({ success: false, error: `Unknown action: ${action}` }),
            error: true,
          }
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

let _anchorTool: AnchorTool | null = null

export function getAnchorTool(): AnchorTool {
  if (!_anchorTool) {
    _anchorTool = new AnchorTool()
  }
  return _anchorTool
}