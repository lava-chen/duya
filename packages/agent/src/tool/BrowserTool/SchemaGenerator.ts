import { z } from 'zod/v4';
import type { ActionHandler } from './actions/types.js';

/**
 * Auto-generates JSON Schema from ActionHandlers' zod schemas.
 * Eliminates the dual-schema maintenance problem.
 */
export class SchemaGenerator {
  static generate(allActions: ActionHandler[]): {
    inputSchema: Record<string, unknown>;
    operations: string[];
  } {
    const operations = allActions.map(a => a.operation);
    const properties: Record<string, unknown> = {};

    for (const action of allActions) {
      const shape = this.extractShape(action.schema as any);
      if (!shape) continue;
      for (const [key, value] of Object.entries(shape)) {
        if (properties[key]) continue;
        properties[key] = value;
      }
    }

    return {
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: operations,
            description: 'Browser operation to perform',
          },
          ...properties,
        },
        required: ['operation'],
      },
      operations,
    };
  }

  private static extractShape(obj: any): Record<string, unknown> | null {
    try {
      const shape = obj._def?.shape?.() || obj._def?.shape || obj.shape;
      if (!shape || typeof shape !== 'object') return null;

      const result: Record<string, unknown> = {};
      for (const [key, prop] of Object.entries(shape) as [string, any][]) {
        result[key] = this.zodToJsonSchemaProp(prop);
      }
      return result;
    } catch {
      return null;
    }
  }

  private static zodToJsonSchemaProp(prop: any): Record<string, unknown> {
    const def = prop._def || prop.def || {};
    const description = prop.description || def?.description || '';
    const base: Record<string, unknown> = description ? { description } : {};

    // Determine type by constructor name
    const typeName = def?.typeName || prop._type || '';

    if (typeName === 'ZodString' || def?.checks?.some?.((c: any) => c.kind === 'url')) {
      const hasUrl = def?.checks?.some?.((c: any) => c.kind === 'url');
      return { ...base, type: 'string', ...(hasUrl ? { format: 'uri' } : {}) };
    }

    if (typeName === 'ZodNumber') {
      return { ...base, type: 'number' };
    }

    if (typeName === 'ZodBoolean') {
      return { ...base, type: 'boolean' };
    }

    if (typeName === 'ZodArray' || def?.type === 'array') {
      const itemType = def?.typeName === 'ZodArray' ? def?.type : def?.element;
      return {
        ...base,
        type: 'array',
        items: itemType ? this.zodToJsonSchemaProp(itemType) : { type: 'string' },
      };
    }

    if (typeName === 'ZodEnum') {
      return { ...base, type: 'string', enum: def?.values || [] };
    }

    if (typeName === 'ZodUnion') {
      const options = def?.options || [];
      const types = new Set<string>();
      for (const opt of options) {
        const resolved = this.zodToJsonSchemaProp(opt);
        if (resolved.type) {
          if (Array.isArray(resolved.type)) {
            for (const t of resolved.type) types.add(t as string);
          } else {
            types.add(resolved.type as string);
          }
        }
      }
      return { ...base, type: types.size === 1 ? [...types][0] : [...types] };
    }

    if (typeName === 'ZodOptional') {
      const inner = this.zodToJsonSchemaProp(def?.innerType || def?.type);
      return { ...inner, ...base };
    }

    if (typeName === 'ZodDefault') {
      const inner = this.zodToJsonSchemaProp(def?.innerType || def?.type);
      return { ...inner, ...base, default: def?.defaultValue?.() ?? def?.defaultValue };
    }

    // Fallback for unknown types
    return { ...base, type: 'string' };
  }
}
