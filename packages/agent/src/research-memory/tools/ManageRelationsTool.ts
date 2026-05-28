import { z } from 'zod'
import { BaseTool } from '../../tool/BaseTool.js'
import type { ToolResult } from '../../tool/types.js'
import type { ToolUseContext } from '../../types.js'
import type { ResearchMemoryStore } from '../store.js'

const inputSchema = z.object({
  action: z.enum(['create', 'list_by_memory', 'list_by_project', 'delete']),
  projectId: z.string().optional(),
  memoryId: z.string().optional(),
  fromMemoryId: z.string().optional(),
  toMemoryId: z.string().optional(),
  relationType: z.string().optional(),
  relationId: z.string().optional(),
})

const VALID_RELATION_TYPES = [
  'supports',
  'contradicts',
  'supersedes',
  'derives_from',
  'informs',
  'depends_on',
  'refutes',
  'extends',
  'replicates',
  'generalizes',
]

export class ManageRelationsTool extends BaseTool {
  readonly name = 'research_memory:manage_relations'
  readonly description = `Manage explicit relations between research memory objects. Use to build a knowledge graph that connects experiments to hypotheses, decisions to evidence, etc. Valid relation types: ${VALID_RELATION_TYPES.join(', ')}`
  readonly input_schema = inputSchema

  private store: ResearchMemoryStore

  constructor(store: ResearchMemoryStore) {
    super()
    this.store = store
  }

  async execute(input: Record<string, unknown>, _workingDirectory?: string, _context?: ToolUseContext): Promise<ToolResult> {
    const { action, projectId, memoryId, fromMemoryId, toMemoryId, relationType, relationId } = inputSchema.parse(input)

    switch (action) {
      case 'create': {
        if (!projectId || !fromMemoryId || !toMemoryId || !relationType) {
          return {
            id: `manage_relations_${Date.now()}`,
            name: this.name,
            result: 'Missing required fields: projectId, fromMemoryId, toMemoryId, relationType',
            error: true,
          }
        }
        const relation = await this.store.createRelation({
          projectId,
          fromMemoryId,
          toMemoryId,
          relationType,
        })
        return {
          id: relation.id,
          name: this.name,
          result: JSON.stringify(relation, null, 2),
          metadata: { relationId: relation.id, relationType },
        }
      }

      case 'list_by_memory': {
        if (!memoryId) {
          return {
            id: `manage_relations_${Date.now()}`,
            name: this.name,
            result: 'Missing required field: memoryId',
            error: true,
          }
        }
        const relations = await this.store.listRelationsByMemory(memoryId)
        return {
          id: `manage_relations_${Date.now()}`,
          name: this.name,
          result: JSON.stringify(relations, null, 2),
          metadata: { count: relations.length, memoryId },
        }
      }

      case 'list_by_project': {
        if (!projectId) {
          return {
            id: `manage_relations_${Date.now()}`,
            name: this.name,
            result: 'Missing required field: projectId',
            error: true,
          }
        }
        const relations = await this.store.listRelationsByProject(projectId)
        return {
          id: `manage_relations_${Date.now()}`,
          name: this.name,
          result: JSON.stringify(relations, null, 2),
          metadata: { count: relations.length, projectId },
        }
      }

      case 'delete': {
        if (!relationId) {
          return {
            id: `manage_relations_${Date.now()}`,
            name: this.name,
            result: 'Missing required field: relationId',
            error: true,
          }
        }
        const success = await this.store.deleteRelation(relationId)
        return {
          id: relationId,
          name: this.name,
          result: JSON.stringify({ success, message: success ? 'Relation deleted.' : 'Relation not found.' }, null, 2),
          metadata: { relationId, deleted: success },
        }
      }

      default:
        return {
          id: `manage_relations_${Date.now()}`,
          name: this.name,
          result: `Unknown action: ${action}`,
          error: true,
        }
    }
  }
}